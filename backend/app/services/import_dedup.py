"""Cross-import de-duplication (M8 H).

Before M8 the ONLY idempotency in the import path was per-``Import``-row
(``tasks.importing``'s Redis lock + orphan-detect entry guard), which protects
against Celery redelivery of the SAME import. Nothing stopped a SECOND import
of the same remote model from creating a second Model -- ``create_import``
always inserted a fresh row and ``create_imported_model_sync`` never looked for
an existing source. That is harmless for a one-off manual click, but a periodic
collection sync (H) re-walks the same lists forever, so it would mint a
duplicate model on every single run.

The identity of a remote model is ``(site, external_id)`` -- both already
stored on ``imports``. A model is considered ALREADY IN THE LIBRARY when a
``done`` import for that pair still points at a live Model. ``model_id`` is
``ON DELETE SET NULL``, so a ``done`` row whose model was later deleted has
``model_id IS NULL`` and must NOT block a re-import -- which is exactly why the
guard checks ``model_id IS NOT NULL`` rather than merely ``state = 'done'``.

NOTE (deliberate): no UNIQUE index enforces this. An install that predates the
guard may already hold duplicate ``done`` rows for one pair, and a unique index
would make the migration fail on their data. The lookup index added alongside
this module keeps the check cheap; promoting it to UNIQUE is safe only after a
one-time de-dup pass.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.models.enums import ImportSite, ImportState
from app.models.system import Import


def _live_import_stmt(site: ImportSite, external_id: str):
    return (
        select(Import)
        .where(
            Import.site == site,
            Import.external_id == external_id,
            Import.state == ImportState.DONE,
            Import.model_id.is_not(None),
        )
        .order_by(Import.id)
        .limit(1)
    )


async def find_live_import(
    db: AsyncSession, site: ImportSite, external_id: str | None
) -> Import | None:
    """The existing ``done`` import whose Model is still in the library, or
    None. ``external_id`` None (a site whose canonicalize found no id) can
    never be matched, so it always reads as "not imported"."""
    if not external_id:
        return None
    return (await db.execute(_live_import_stmt(site, external_id))).scalars().first()


def find_live_import_sync(
    session: SyncSession, site: ImportSite, external_id: str | None
) -> Import | None:
    """Worker-side twin of :func:`find_live_import` (the collection sync task
    runs entirely in the sync world -- see ``app.tasks.base``)."""
    if not external_id:
        return None
    return session.execute(_live_import_stmt(site, external_id)).scalars().first()
