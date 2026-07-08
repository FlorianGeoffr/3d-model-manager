"""Thingiverse importer over the official REST API (SPEC/FULL line 228:
GET /things/{id}, zip_data.files[]/images[], Authorization: Bearer). The
app token is read from Settings (import_tokens) inside the worker. License
strings are mapped manually (FULL: "Manyfold distrusts the field"). ``_client``
is the ONE seam tests monkeypatch with an httpx.MockTransport."""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import urlparse

import httpx

from app.importers.base import ImportFile, ImportMetadata, ResolvedDownload, safe_filename
from app.importers.registry import register_importer
from app.models.enums import ImportSite

_BASE_URL = "https://api.thingiverse.com"
_ALLOWED_HOSTS = {"thingiverse.com", "www.thingiverse.com"}
_ID_RE = re.compile(r"(?:thing:|.*?[?&]thing=)(\d+)", re.IGNORECASE)
_UA = "3d-model-manager/1.0 (+https://github.com/metril/3d-model-manager)"

# Manual license map (FULL line 228). Falls back to the raw string.
_LICENSE_MAP = {
    "creative commons - attribution": "CC-BY-4.0",
    "creative commons - attribution - share alike": "CC-BY-SA-4.0",
    "creative commons - attribution - no derivatives": "CC-BY-ND-4.0",
    "creative commons - attribution - non-commercial": "CC-BY-NC-4.0",
    "creative commons - public domain dedication": "CC0-1.0",
    "public domain": "CC0-1.0",
}


def _client(token: str | None) -> httpx.Client:
    headers = {"User-Agent": _UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(base_url=_BASE_URL, headers=headers, timeout=30.0, follow_redirects=True)


def _map_license(raw: str | None) -> str | None:
    if not raw:
        return None
    return _LICENSE_MAP.get(raw.strip().lower(), raw)


def _token() -> str | None:
    from app.config import get_settings
    from app.services.import_tokens import get_import_tokens_sync
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s:
        return get_import_tokens_sync(s, settings).thingiverse_token


class ThingiverseImporter:
    site: ClassVar[ImportSite] = ImportSite.THINGIVERSE

    def canonicalize(self, url: str) -> str | None:
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            return None
        if host not in _ALLOWED_HOSTS:
            return None
        m = _ID_RE.search(url)
        return m.group(1) if m else None

    def _thing(self, external_id: str) -> dict:
        with _client(_token()) as c:
            r = c.get(f"/things/{external_id}")
            r.raise_for_status()
            return r.json()

    def fetch_metadata(self, external_id: str) -> ImportMetadata:
        d = self._thing(external_id)
        images = (d.get("zip_data") or {}).get("images") or []
        return ImportMetadata(
            site=self.site,
            external_id=str(external_id),
            source_url=f"https://www.thingiverse.com/thing:{external_id}",
            title=d.get("name") or f"thing {external_id}",
            description=d.get("description"),
            author=(d.get("creator") or {}).get("name"),
            license=_map_license(d.get("license")),
            cover_url=images[0].get("url") if images else None,
            tags=tuple(t["name"] for t in d.get("tags", []) if t.get("name")),
        )

    def list_files(self, external_id: str) -> list[ImportFile]:
        d = self._thing(external_id)
        files = (d.get("zip_data") or {}).get("files") or []
        return [
            ImportFile(
                remote_id=str(f.get("name")),
                filename=safe_filename(f.get("name")),
                url=f.get("download_url"),
                size=f.get("size"),
            )
            for f in files
            if f.get("name") and f.get("download_url")
        ]

    def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
        token = _token()
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return ResolvedDownload(url=file.url or "", filename=file.filename, headers=headers)


register_importer(ThingiverseImporter())
