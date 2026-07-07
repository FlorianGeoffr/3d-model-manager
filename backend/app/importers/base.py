"""The SiteImporter contract (SPEC "Gallery importers"; FULL line 218
``class SiteImporter(Protocol):``). A structural Protocol -- concrete
importers (Thingiverse/Printables) do not subclass it; they just satisfy
the four methods and declare ``site`` for registry keying. The three frozen
dataclasses are the normalized shapes the orchestration task (Task 3)
speaks, so no importer leaks a site-specific dict past this boundary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar, Protocol, runtime_checkable

from app.models.enums import ImportSite


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
