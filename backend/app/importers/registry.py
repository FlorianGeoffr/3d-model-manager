"""ImportSite-keyed importer registry (mirrors app.printers.registry).
``build_importer_for_url`` is the single site-auto-detection seam the API
uses. Concrete importers register an INSTANCE at their module bottom; this
module imports ``thingiverse``/``printables``/``makerworld`` at its BOTTOM
so importing the registry triggers registration (same pattern as the
printers registry importing ``bambu``)."""

from __future__ import annotations

from urllib.parse import urlparse

from app.importers.base import SiteImporter
from app.models.enums import ImportSite

IMPORTER_REGISTRY: dict[ImportSite, SiteImporter] = {}

# Sites whose importer isn't registered yet get a friendly "not available
# yet" instead of a generic "unsupported URL" -- a deferred site's URL must
# NEVER crash (Global Constraints). Empty as of Workstream B task B1
# (MakerWorld shipped its anonymous half and is no longer deferred); kept as
# a mechanism for a future site that isn't ready yet.
_DEFERRED_HOSTS: dict[str, ImportSite] = {}


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


def get_importer(site: ImportSite) -> SiteImporter | None:
    """Look up a registered importer by site (the search dispatch seam for
    ``GET /imports/search`` -- a thin, testable wrapper over the dict so
    call sites don't reach into ``IMPORTER_REGISTRY`` directly)."""
    return IMPORTER_REGISTRY.get(site)


from app.importers import makerworld as _makerworld  # noqa: E402,F401  (registers makerworld)
from app.importers import printables as _printables  # noqa: E402,F401  (registers printables)
from app.importers import thingiverse as _thingiverse  # noqa: E402,F401  (registers thingiverse)
