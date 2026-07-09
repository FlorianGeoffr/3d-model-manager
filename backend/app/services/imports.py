"""Starting an import (M8 H extraction).

``POST /imports`` and "approve a queued review item" must behave identically:
detect the site, canonicalize, refuse to duplicate a model already in the
library (``app.services.import_dedup``), otherwise create the ``Import`` row and
dispatch the pipeline. Sharing one function keeps the dedup guard from drifting
between the two call sites.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.importers.registry import build_importer_for_url, deferred_site_for_url
from app.models.enums import ImportState
from app.models.system import Import
from app.services.import_dedup import find_live_import
from app.tasks.importing import import_from_url


async def start_import(db: AsyncSession, url: str) -> tuple[Import, bool]:
    """Returns ``(import_row, created)``. ``created`` is False when the model was
    already in the library -- the caller then hands back the EXISTING import
    (and should signal "nothing was created", e.g. HTTP 200 instead of 201).
    """
    importer = build_importer_for_url(url)
    if importer is None:
        deferred = deferred_site_for_url(url)
        if deferred is not None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{deferred.value} import isn't available yet.",
            )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Unsupported URL -- paste a Thingiverse, Printables, or MakerWorld model link.",
        )

    external_id = importer.canonicalize(url)
    existing = await find_live_import(db, importer.site, external_id)
    if existing is not None:
        return existing, False

    imp = Import(url=url, site=importer.site, external_id=external_id, state=ImportState.PENDING)
    db.add(imp)
    await db.commit()
    await db.refresh(imp)

    import_from_url.apply_async(args=[imp.id], task_id=f"import-{imp.id}")

    # Under eager Celery (tests) the line above ran the whole import inline
    # through its own SYNC session, driving the row to done/failed -- refresh so
    # this async session hands back the terminal state, not the stale "pending"
    # snapshot (same reasoning as app.api.settings.migrate).
    await db.refresh(imp)
    return imp, True
