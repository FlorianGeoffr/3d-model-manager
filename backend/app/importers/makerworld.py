"""MakerWorld importer over the JSON `/api/v1` surface (Workstream B tasks
B1+B2; SPEC "Gallery importers"). ``canonicalize``/``fetch_metadata``/
``search`` work anonymously -- no Bambu account needed, which is what makes
MakerWorld useful in the search UI immediately. ``list_files``/
``resolve_download`` (the actual file download) additionally need a
Bambu-authenticated call (task B2, ``app.services.bambu_auth``): without a
connected account both still raise ``ImportRejected`` with a clear,
user-facing message; with one, they hit the authenticated download endpoint
-- see ``_fetch_authed_download_url``'s docstring for exactly how
UNVERIFIED that endpoint is. ``_client`` is the ONE httpx seam tests
monkeypatch for the anonymous calls (same contract as
``printables._client``/``thingiverse._client``); ``_authed_client`` is the
analogous seam for the Bearer-authenticated download call.

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

from app.importers.base import (
    ImportFile,
    ImportMetadata,
    RemoteList,
    ResolvedDownload,
    SearchResult,
    safe_filename,
)
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


def _authed_client(token: str, region: str = "global") -> httpx.Client:
    """The Bearer-authenticated seam (mirrors ``thingiverse._client(token)``)
    -- used ONLY by ``_fetch_authed_download_url`` for the token-gated
    download call, which lives on the Bambu account host
    (``api.bambulab.com``/``.cn``), NOT ``makerworld.com``."""
    from app.services.bambu_auth import base_url_for_region

    return httpx.Client(
        base_url=base_url_for_region(region),
        timeout=30.0,
        follow_redirects=True,
        headers={"User-Agent": _UA, "Authorization": f"Bearer {token}"},
    )


def _bambu_session() -> tuple[str, str]:
    """(access_token, region) for the connected Bambu account -- mirrors
    ``thingiverse._token()``'s worker-session pattern (``get_..._sync`` +
    ``sync_session``). Raises ``app.services.bambu_auth.BambuAuthError`` when
    no account is connected (or its stored refresh token can no longer
    produce an access token); the two wrappers below decide how each caller
    handles that."""
    from app.config import get_settings
    from app.services.bambu_auth import get_access_token_sync, get_bambu_auth_sync
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s:
        region = get_bambu_auth_sync(s, settings).region
        return get_access_token_sync(s, settings), region


def _bambu_session_or_none() -> tuple[str, str] | None:
    """Soft variant for ``search()``: not being connected is not an error,
    just anonymous behavior."""
    from app.services.bambu_auth import BambuAuthError

    try:
        return _bambu_session()
    except BambuAuthError:
        return None


def _require_bambu_session() -> tuple[str, str]:
    """Hard variant for ``list_files``/``resolve_download``: not being
    connected (or a dead refresh token) becomes the same clear, user-facing
    ``ImportRejected`` the B1 stub raised unconditionally."""
    from app.services.bambu_auth import BambuAuthError
    from app.tasks.importing import ImportRejected

    try:
        return _bambu_session()
    except BambuAuthError as exc:
        raise ImportRejected(_BAMBU_AUTH_REQUIRED) from exc


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
        # Bambu-authenticated download (B2). MakerWorld's design/instance
        # JSON carries no downloadable-file URL anonymously (only cover/
        # plate thumbnails) -- `hasZipStl: true` on an instance just means a
        # download EXISTS, not that we can reach it without a Bambu Bearer
        # token. `_require_bambu_session` turns "not connected" into the
        # same clear, user-facing rejection the B1 stub raised
        # unconditionally (never a crash, never a silent "no files found"
        # which would misreport WHY).
        _require_bambu_session()
        d = self._design(external_id)
        title = d.get("title") or f"model {external_id}"
        files = []
        for inst in d.get("instances", []):
            if not inst.get("hasZipStl"):
                continue
            profile_id = inst.get("profileId")
            if not profile_id:
                continue
            name = inst.get("title") or title
            filename = safe_filename(f"{name}-{inst.get('id')}.zip")
            files.append(ImportFile(remote_id=str(profile_id), filename=filename))
        return files

    def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
        token, region = _require_bambu_session()
        # The download endpoint (see `_fetch_authed_download_url`) is keyed
        # on `profileId` (carried through as `file.remote_id`) + the
        # design's `modelId` string -- re-fetch the (anonymous, cheap)
        # design detail rather than widening `ImportFile` with a MakerWorld-
        # specific field just to carry `modelId` from `list_files` to here.
        d = self._design(external_id)
        url = self._fetch_authed_download_url(
            profile_id=file.remote_id, model_id=d.get("modelId"), token=token, region=region
        )
        return ResolvedDownload(url=url, filename=file.filename)

    # === UNVERIFIED: Bambu-authenticated download endpoint (B2) ===========
    def _fetch_authed_download_url(
        self, *, profile_id: str, model_id: str | None, token: str, region: str
    ) -> str:
        """ISOLATED on purpose: this is the ONE piece of the importer that
        could NOT be live-verified (grounding probe: every anonymous
        candidate path 404s, and this one requires a real logged-in Bambu
        token). It targets the endpoint documented in this project's own
        approved design spec (``docs/superpowers/specs/2026-07-04-3d-model-
        manager-design-full.md`` line 230): ``GET /v1/iot-service/api/user/
        profile/{profileId}?model_id=<id>`` on the Bambu account host
        (``api.bambulab.com``/``.cn`` -- the SAME host that issues the
        Bearer token, not ``makerworld.com``), returning a short-TTL (~5 min)
        presigned S3 file URL that must be fetched immediately, never
        cached/normalized.

        NEITHER the exact response field carrying that URL NOR whether
        ``model_id`` wants the design's numeric ``id`` or its ``modelId``
        string (used here, since the query-param name matches that JSON key
        literally) was ever captured against a real Bambu account -- this
        MUST be re-verified against a live connected account before it's
        trusted in production. If the real shape differs, only this method
        (and the field-name tolerance list below) should need adjusting.
        """
        with _authed_client(token, region) as c:
            r = c.get(
                f"/iot-service/api/user/profile/{profile_id}",
                params={"model_id": model_id or ""},
            )
            r.raise_for_status()
            body = r.json()
        candidates = (body, body.get("data") if isinstance(body.get("data"), dict) else None)
        url_keys = (
            "url",
            "presignedUrl",
            "presigned_url",
            "downloadUrl",
            "download_url",
            "fileUrl",
        )
        for candidate in candidates:
            if not candidate:
                continue
            for key in url_keys:
                value = candidate.get(key)
                if value:
                    return value
        from app.tasks.importing import ImportRejected

        raise ImportRejected(
            "MakerWorld's authenticated download response didn't include a recognizable "
            "file URL (the endpoint's shape may have changed -- see "
            "MakerWorldImporter._fetch_authed_download_url)."
        )

    # ========================================================================

    def search(self, query: str, page: int = 1) -> list[SearchResult]:
        if not query:
            return []
        offset = max(page - 1, 0) * _SEARCH_PAGE_SIZE
        # Anonymous search ignores `q` and returns trending regardless
        # (grounding note, `tests/cassettes/makerworld_fixtures.py`) --
        # sending the Bearer token when a Bambu account is connected lets an
        # authenticated request respect the query instead. Not connected is
        # NOT an error here (unlike list_files/resolve_download): search
        # still works anonymously, just degraded to trending.
        session = _bambu_session_or_none()
        headers = {"Authorization": f"Bearer {session[0]}"} if session else None
        with _client() as c:
            r = c.get(
                "/search-service/select/design",
                params={"q": query, "limit": _SEARCH_PAGE_SIZE, "offset": offset},
                headers=headers,
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

    # -- saved collections / likes (M8 H) ---------------------------------
    # The seam is live (the API + the periodic sync task call through it), but
    # the authenticated calls are NOT wired yet. We DO hold a user-scoped Bambu
    # access token (`_bambu_session`), yet no MakerWorld collections/likes
    # endpoint is mapped anywhere -- and the one authed endpoint we do have is
    # already flagged documented-not-verified. Guessing a second one would
    # compound that; it lands once a real logged-in request can be captured.
    # Returning [] is the "nothing to show, not an error" convention `search`
    # uses.

    def list_user_lists(self) -> list[RemoteList]:
        return []

    def list_list_items(self, list_id: str, page: int = 1) -> list[SearchResult]:
        return []


register_importer(MakerWorldImporter())
