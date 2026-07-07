from datetime import UTC, datetime

import pytest

from app.models.library import Revision
from app.services import library


@pytest.mark.asyncio
async def test_manual_create_model_still_yields_rev_001_initial(db_session, backend):
    model = await library.create_model(db_session, backend, name="Manual Widget", description=None)
    cur = await db_session.get(Revision, model.current_revision_id)
    assert cur.dir_name == "rev-001_initial" and cur.name == "initial"
    assert model.source_site is None and model.imported_at is None


@pytest.mark.asyncio
async def test_create_imported_model_sync_sets_provenance_and_rev_imported(db_session, backend):
    # sync helper uses a SYNC session; drive it against the SAME testcontainer
    # DB via app.tasks.base.sync_session (the worker engine).
    from app.models.library import Model, Revision
    from app.tasks.base import sync_session

    when = datetime(2026, 7, 7, tzinfo=UTC)
    with sync_session() as s:
        model = library.create_imported_model_sync(
            s,
            backend,
            name="Imported Vase",
            description="from a gallery",
            source_url="https://www.thingiverse.com/thing:763622",
            source_site="thingiverse",
            source_author="alice",
            source_license="CC-BY-4.0",
            imported_at=when,
            tags=["vase", "spiral"],
            initial_revision_name="imported",
        )
        mid = model.id
    with sync_session() as s:
        m = s.get(Model, mid)
        rev = s.get(Revision, m.current_revision_id)
        assert rev.dir_name == "rev-001_imported" and rev.name == "imported"
        assert m.source_site == "thingiverse" and m.source_author == "alice"
        assert m.source_license == "CC-BY-4.0" and m.imported_at is not None
        assert {t.name for t in m.tags} == {"vase", "spiral"}
