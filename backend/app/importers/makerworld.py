"""MakerWorld importer over the JSON `/api/v1` surface (Workstream B task
B1; SPEC "Gallery importers"). ONLY the anonymous half ships here:
``canonicalize``/``fetch_metadata``/``search`` all work without a Bambu
account, which is what makes MakerWorld useful in the search UI immediately.
``list_files``/``resolve_download`` (the actual file download) need a
Bambu-authenticated call that a live grounding probe could NOT discover
anonymously (every plausible anonymous download path 404s) -- both raise
``ImportRejected`` with a clear, user-facing message until task B2 wires up
Bambu Lab login. ``_client`` is the ONE httpx seam tests monkeypatch, same
contract as ``printables._client``/``thingiverse._client``.

Cloudflare note (grounding probe): `makerworld.com/en/...` HTML pages ARE
Cloudflare-challenged (403 `cf-mitigated: challenge`), but the `/api/v1/...`
JSON endpoints used below are reachable by plain httpx with a browser UA --
never scrape HTML here.

Reject-rule note (live-verified, deliberately NOT a literal reading of
"paidSetting is set" / "isExclusive is true"): a 200-design live sample
found `paidSetting` present as a non-null `{"isPaid": bool, "crowdfunding":
int}` object on EVERY design, including obviously-free ones -- it is never
omitted, so "is set" (non-None) is not a paid signal. `isExclusive` was
`true` on ~90% of that same sample; it flags MakerWorld's creator-rewards
"Exclusive" program, not a paywall (every sampled exclusive design still had
`instances[].hasZipStl: true`). Gating on either field's mere
presence/truthiness would reject nearly all MakerWorld search results,
directly defeating this task's stated goal. The actual paid signal is
`paidSetting.isPaid` (false on all 200 samples, so real paid designs are
rare, but the field is genuine) -- this mirrors Printables' `premium`
boolean check exactly, just nested one level deeper."""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import urlparse

import httpx

from app.importers.base import ImportFile, ImportMetadata, ResolvedDownload, SearchResult
from app.importers.registry import register_importer
from app.models.enums import ImportSite

_BASE_URL = "https://makerworld.com/api/v1"
_ALLOWED_HOSTS = {"makerworld.com", "www.makerworld.com"}
# MakerWorld URLs: /en/models/<id>[-<slug>] (locale prefix optional/variable:
# /de/, /fr/, /zh/, /ja/, ... or none at all) -- the id is always the numeric
# segment right after "models/".
_ID_RE = re.compile(r"models/(\d+)", re.IGNORECASE)
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)
_SEARCH_PAGE_SIZE = 20

_BAMBU_AUTH_REQUIRED = (
    "MakerWorld downloads require signing in with a Bambu account (configure in Settings)."
)


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=_BASE_URL, timeout=30.0, follow_redirects=True, headers={"User-Agent": _UA}
    )


class MakerWorldImporter:
    site: ClassVar[ImportSite] = ImportSite.MAKERWORLD

    def canonicalize(self, url: str) -> str | None:
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            return None
        if host not in _ALLOWED_HOSTS:
            return None
        m = _ID_RE.search(url)
        return m.group(1) if m else None

    def _design(self, external_id: str) -> dict:
        with _client() as c:
            r = c.get(f"/design-service/design/{external_id}")
            r.raise_for_status()
            return r.json()

    def fetch_metadata(self, external_id: str) -> ImportMetadata:
        d = self._design(external_id)
        reject = None
        if (d.get("paidSetting") or {}).get("isPaid"):
            reject = "This is a paid MakerWorld model and can't be imported (login required)."
        return ImportMetadata(
            site=self.site,
            external_id=str(external_id),
            source_url=f"https://www.makerworld.com/en/models/{external_id}",
            title=d.get("title") or f"model {external_id}",
            description=d.get("summary"),
            author=(d.get("designCreator") or {}).get("name"),
            license=d.get("license"),
            cover_url=d.get("coverUrl"),
            tags=tuple(t for t in d.get("tags", []) if t),
            reject_reason=reject,
        )

    def list_files(self, external_id: str) -> list[ImportFile]:
        # TODO(B2): Bambu-authenticated download. MakerWorld's design/
        # instance JSON carries no downloadable-file URL anonymously (only
        # cover/plate thumbnails) -- `hasZipStl: true` on an instance just
        # means a download EXISTS, not that we can reach it without a Bambu
        # Bearer token. Reject cleanly here (never a crash, never a silent
        # "no files found" which would misreport WHY).
        from app.tasks.importing import ImportRejected

        raise ImportRejected(_BAMBU_AUTH_REQUIRED)

    def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
        # TODO(B2): Bambu-authenticated download.
        from app.tasks.importing import ImportRejected

        raise ImportRejected(_BAMBU_AUTH_REQUIRED)

    def search(self, query: str, page: int = 1) -> list[SearchResult]:
        if not query:
            return []
        offset = max(page - 1, 0) * _SEARCH_PAGE_SIZE
        with _client() as c:
            r = c.get(
                "/search-service/select/design",
                params={"q": query, "limit": _SEARCH_PAGE_SIZE, "offset": offset},
            )
            r.raise_for_status()
            body = r.json()
        results = []
        for hit in body.get("hits", []):
            mid = hit.get("id")
            if not mid:
                continue
            results.append(
                SearchResult(
                    site=self.site,
                    external_id=str(mid),
                    title=hit.get("title") or f"model {mid}",
                    url=f"https://www.makerworld.com/en/models/{mid}",
                    author=(hit.get("designCreator") or {}).get("name"),
                    thumbnail_url=hit.get("cover"),
                )
            )
        return results


register_importer(MakerWorldImporter())
