"""Printables importer over the UNOFFICIAL GraphQL API (SPEC/FULL line 229:
POST api.printables.com/graphql/, print(id:) + getDownloadLink, browser-like
UA, anonymous for free models; Club/paid rejected). ALL GraphQL is isolated
in this one module (the SPEC's contract-test seam) -- ``_client`` is the ONE
seam tests monkeypatch. A Cloudflare tightening would be handled by a
cloudscraper fallback hook (documented later escalation, not a v1 dep)."""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import urlparse

import httpx

from app.importers.base import (
    ImportFile,
    ImportMetadata,
    ResolvedDownload,
    SearchResult,
    safe_filename,
)
from app.importers.registry import register_importer
from app.models.enums import ImportSite

_GRAPHQL_URL = "https://api.printables.com/graphql/"
_IMG_BASE = "https://media.printables.com/"
_ALLOWED_HOSTS = {"printables.com", "www.printables.com"}
# Printables URLs: /model/<numericId>-<slug> (the id is the numeric prefix).
_ID_RE = re.compile(r"model/(\d+)", re.IGNORECASE)
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)

PRINT_QUERY = """
query PrintProfile($id: ID!) {
  print(id: $id) {
    id name description
    user { publicUsername }
    license { name }
    tags { name }
    image { filePath }
    premium
    stls { id name fileSize }
  }
}
""".strip()

# Discovered live (Workstream B task B1) via GraphQL introspection on the
# anonymous endpoint: the root Query type has no field literally named
# "search" -- `searchPrints2(query:, offset:, limit:)` is the one that
# actually text-filters (confirmed: query="benchy" returns Benchy-relevant
# hits, a nonsense query returns none). `quickSearchPrints` also exists (the
# omnibox typeahead) but takes no offset/limit, so it can't page.
SEARCH_QUERY = """
query SearchPrints($query: String!, $limit: Int, $offset: Int) {
  searchPrints2(query: $query, limit: $limit, offset: $offset) {
    totalCount
    items { id name image { filePath } user { publicUsername } }
  }
}
""".strip()

_SEARCH_PAGE_SIZE = 20

DOWNLOAD_MUTATION = """
mutation GetDownloadLink(
  $printId: ID!
  $files: [DownloadFileInput]!
  $source: DownloadSourceEnum!
) {
  getDownloadLink(printId: $printId, files: $files, source: $source) {
    ok output { link }
  }
}
""".strip()


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=_GRAPHQL_URL,
        timeout=30.0,
        follow_redirects=True,
        headers={
            "User-Agent": _UA,
            "Content-Type": "application/json",
            "Origin": "https://www.printables.com",
            "Referer": "https://www.printables.com/",
        },
    )


def _post(client: httpx.Client, query: str, variables: dict) -> dict:
    r = client.post("", json={"query": query, "variables": variables})
    r.raise_for_status()
    body = r.json()
    if body.get("errors"):
        raise RuntimeError(f"Printables GraphQL error: {body['errors']}")
    return body["data"]


class PrintablesImporter:
    site: ClassVar[ImportSite] = ImportSite.PRINTABLES

    def canonicalize(self, url: str) -> str | None:
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            return None
        if host not in _ALLOWED_HOSTS:
            return None
        m = _ID_RE.search(url)
        return m.group(1) if m else None

    def _print(self, external_id: str) -> dict:
        with _client() as c:
            return _post(c, PRINT_QUERY, {"id": external_id})["print"]

    def fetch_metadata(self, external_id: str) -> ImportMetadata:
        p = self._print(external_id)
        reject = None
        if p.get("premium"):
            reject = (
                "This is a Printables Club / paid model and can't be imported (login required)."
            )
        image = p.get("image") or {}
        cover = f"{_IMG_BASE}{image['filePath']}" if image.get("filePath") else None
        return ImportMetadata(
            site=self.site,
            external_id=str(external_id),
            source_url=f"https://www.printables.com/model/{external_id}",
            title=p.get("name") or f"print {external_id}",
            description=p.get("description"),
            author=(p.get("user") or {}).get("publicUsername"),
            license=(p.get("license") or {}).get("name"),
            cover_url=cover,
            tags=tuple(t["name"] for t in p.get("tags", []) if t.get("name")),
            reject_reason=reject,
        )

    def list_files(self, external_id: str) -> list[ImportFile]:
        p = self._print(external_id)
        return [
            ImportFile(
                remote_id=str(s["id"]),
                filename=safe_filename(s.get("name")),
                url=None,
                size=s.get("fileSize"),
            )
            for s in p.get("stls", [])
            if s.get("id") and s.get("name")
        ]

    def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
        with _client() as c:
            data = _post(
                c,
                DOWNLOAD_MUTATION,
                {
                    "printId": external_id,
                    "source": "model_detail",
                    "files": [{"fileType": "stl", "ids": [file.remote_id]}],
                },
            )
        out = (data.get("getDownloadLink") or {}).get("output") or {}
        link = out.get("link")
        if not link:
            raise RuntimeError(f"Printables returned no download link for file {file.remote_id}")
        return ResolvedDownload(url=link, filename=file.filename)

    def search(self, query: str, page: int = 1) -> list[SearchResult]:
        if not query:
            return []
        offset = max(page - 1, 0) * _SEARCH_PAGE_SIZE
        with _client() as c:
            data = _post(
                c, SEARCH_QUERY, {"query": query, "limit": _SEARCH_PAGE_SIZE, "offset": offset}
            )
        items = (data.get("searchPrints2") or {}).get("items") or []
        results = []
        for item in items:
            pid = item.get("id")
            if not pid:
                continue
            image = item.get("image") or {}
            cover = f"{_IMG_BASE}{image['filePath']}" if image.get("filePath") else None
            results.append(
                SearchResult(
                    site=self.site,
                    external_id=str(pid),
                    title=item.get("name") or f"print {pid}",
                    url=f"https://www.printables.com/model/{pid}",
                    author=(item.get("user") or {}).get("publicUsername"),
                    thumbnail_url=cover,
                )
            )
        return results


register_importer(PrintablesImporter())
