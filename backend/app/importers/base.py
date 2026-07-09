"""The SiteImporter contract (SPEC "Gallery importers"; FULL line 218
``class SiteImporter(Protocol):``). A structural Protocol -- concrete
importers (Thingiverse/Printables/MakerWorld) do not subclass it; they just
satisfy the five methods and declare ``site`` for registry keying. The four
frozen dataclasses are the normalized shapes the orchestration task (Task 3)
and the in-app search endpoint (Workstream B task B1) speak, so no importer
leaks a site-specific dict past this boundary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar, Protocol, runtime_checkable

from app.models.enums import ImportSite

# Shared search page size (one call returns at most this many hits per site).
# Centralized so the federated `GET /imports/search` can infer each site's
# `has_more` ("came back full => probably another page") without reaching into
# each importer's private constant.
SEARCH_PAGE_SIZE = 20


@dataclass(frozen=True)
class ImportMetadata:
    """Normalized model metadata. ``reject_reason`` NON-NULL means the model
    is un-importable (paid/Club/exclusive) -- the task raises on it BEFORE
    any download (Global Constraints "PAID/CLUB/EXCLUSIVE REJECTED")."""

    site: ImportSite
    external_id: str
    source_url: str
    title: str
    description: str | None = None
    author: str | None = None
    license: str | None = None
    cover_url: str | None = None
    tags: tuple[str, ...] = ()
    reject_reason: str | None = None


@dataclass(frozen=True)
class ImportFile:
    """One downloadable file. ``url`` carries the site's download URL
    through from ``list_files`` to ``resolve_download`` so the latter need
    not re-fetch (short-TTL URLs are resolved just-in-time when it can't)."""

    remote_id: str
    filename: str
    url: str | None = None
    size: int | None = None


@dataclass(frozen=True)
class ResolvedDownload:
    """A ready-to-stream download: a (possibly short-TTL) URL plus any
    per-request headers (e.g. ``Authorization: Bearer`` for Thingiverse)."""

    url: str
    filename: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchResult:
    """One in-app search hit (Workstream B task B1, ``GET /imports/search``).
    ``url`` is a canonical model URL that the existing ``POST /imports``
    accepts as-is -- it round-trips through the same ``canonicalize`` the
    importer already implements, so search-then-import is just "pick a
    result, POST its url"."""

    site: ImportSite
    external_id: str
    title: str
    url: str
    author: str | None = None
    thumbnail_url: str | None = None


def safe_filename(name: str) -> str:
    """Reduce a remote filename to a safe single-segment rel_path: strip any
    directory prefix and leading dots so a hostile ``../`` name can't escape
    the revision directory. (finalize's storage_path is rel_path-derived.)"""
    base = str(name).replace("\\", "/").rsplit("/", 1)[-1].strip()
    base = base.lstrip(".")
    return base or "file"


@runtime_checkable
class SiteImporter(Protocol):
    site: ClassVar[ImportSite]

    def canonicalize(self, url: str) -> str | None:
        """Return this site's external id parsed from ``url`` (also the
        site-detection signal: non-None ⇒ 'this URL is mine'), else None."""
        ...

    def fetch_metadata(self, external_id: str) -> ImportMetadata: ...
    def list_files(self, external_id: str) -> list[ImportFile]: ...
    def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload: ...

    def search(self, query: str, page: int = 1) -> list[SearchResult]:
        """In-app keyword search (Workstream B task B1). Importers that
        can't search (or have no query terms to work with) may return an
        empty list rather than raise -- an unsearchable site is not an
        error, just nothing to show."""
        ...
