"""Cross-import de-duplication guard (M8 H, ``app.services.import_dedup``).

The identity of a remote model is ``(site, external_id)``. Only a ``done``
import that STILL points at a live Model counts as "already in the library" --
``imports.model_id`` is ``ON DELETE SET NULL``, so deleting the model must make
the pair importable again.
"""

from __future__ import annotations

import pytest

from app.models import Model
from app.models.enums import ImportSite, ImportState
from app.models.system import Import
from app.services.import_dedup import find_live_import, find_live_import_sync


async def _add_import(db_session, *, state: ImportState, model_id: int | None) -> Import:
    imp = Import(
        url="https://fake.test/thing/7",
        site=ImportSite.THINGIVERSE,
        external_id="7",
        state=state,
        model_id=model_id,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)
    return imp


async def _add_model(db_session) -> Model:
    model = Model(slug="already-here", name="Already Here")
    db_session.add(model)
    await db_session.commit()
    await db_session.refresh(model)
    return model


@pytest.mark.asyncio
async def test_finds_a_done_import_with_a_live_model(db_session) -> None:
    model = await _add_model(db_session)
    imp = await _add_import(db_session, state=ImportState.DONE, model_id=model.id)

    found = await find_live_import(db_session, ImportSite.THINGIVERSE, "7")
    assert found is not None and found.id == imp.id


@pytest.mark.asyncio
async def test_ignores_a_done_import_whose_model_was_deleted(db_session) -> None:
    # `model_id` is ON DELETE SET NULL -- a done row with no model must NOT
    # block a fresh import of the same remote model.
    await _add_import(db_session, state=ImportState.DONE, model_id=None)

    assert await find_live_import(db_session, ImportSite.THINGIVERSE, "7") is None


@pytest.mark.asyncio
async def test_ignores_non_done_imports(db_session) -> None:
    model = await _add_model(db_session)
    await _add_import(db_session, state=ImportState.FAILED, model_id=model.id)
    await _add_import(db_session, state=ImportState.PENDING, model_id=None)

    assert await find_live_import(db_session, ImportSite.THINGIVERSE, "7") is None


@pytest.mark.asyncio
async def test_scopes_by_site_and_external_id(db_session) -> None:
    model = await _add_model(db_session)
    await _add_import(db_session, state=ImportState.DONE, model_id=model.id)

    assert await find_live_import(db_session, ImportSite.PRINTABLES, "7") is None
    assert await find_live_import(db_session, ImportSite.THINGIVERSE, "8") is None
    # a site whose canonicalize found no id can never match
    assert await find_live_import(db_session, ImportSite.THINGIVERSE, None) is None


def test_sync_twin_mirrors_the_async_lookup() -> None:
    """The collection-sync task runs in the worker's SYNC world."""
    from app.tasks import base

    with base.sync_session() as session:
        model = Model(slug="sync-here", name="Sync Here")
        session.add(model)
        session.flush()
        session.add(
            Import(
                url="https://fake.test/thing/9",
                site=ImportSite.THINGIVERSE,
                external_id="9",
                state=ImportState.DONE,
                model_id=model.id,
            )
        )
        session.commit()

        found = find_live_import_sync(session, ImportSite.THINGIVERSE, "9")
        assert found is not None and found.external_id == "9"
        assert find_live_import_sync(session, ImportSite.THINGIVERSE, "404") is None
