"""ImportSite-keyed importer registry (mirrors app.printers.registry).
``build_importer_for_url`` is the single site-auto-detection seam the API
uses. Concrete importers register an INSTANCE at their module bottom;
Tasks 4/5 add the ``from app.importers import thingiverse``/``printables``
lines at the BOTTOM of this module so importing the registry triggers
registration (same pattern as the printers registry importing ``bambu``)."""

from __future__ import annotations

from urllib.parse import urlparse

from app.importers.base import SiteImporter
from app.models.enums import ImportSite

IMPORTER_REGISTRY: dict[ImportSite, SiteImporter] = {}

# MakerWorld is deferred (M5 controller decision). Detect its URLs so the
# API/UI can answer with a friendly "not available yet" instead of a generic
# "unsupported URL" -- a MakerWorld URL must NEVER crash (Global Constraints).
_DEFERRED_HOSTS = {
    "makerworld.com": ImportSite.MAKERWORLD,
    "www.makerworld.com": ImportSite.MAKERWORLD,
}


def register_importer(importer: SiteImporter) -> SiteImporter:
    IMPORTER_REGISTRY[importer.site] = importer
    return importer


def build_importer_for_url(url: str) -> SiteImporter | None:
    for importer in IMPORTER_REGISTRY.values():
        if importer.canonicalize(url) is not None:
            return importer
    return None


def deferred_site_for_url(url: str) -> ImportSite | None:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    return _DEFERRED_HOSTS.get(host)


from app.importers import printables as _printables  # noqa: E402,F401  (registers printables)
from app.importers import thingiverse as _thingiverse  # noqa: E402,F401  (registers thingiverse)
