import logging

import httpx
import pytest
import redis.asyncio as aioredis
from sqlalchemy import func, select

from app.config import get_settings
from app.importers import download
from app.importers.base import ResolvedDownload
from app.importers.fake import FAKE_DL, FakeImporter
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportSite, ImportState
from app.models.library import File, Model, Revision
from app.models.system import Import
from app.services import events, library
from app.services.storage_config import resolve_backend_sync
from app.tasks.importing import import_from_url
from tests import corpus

# `import_from_url` publishes SSE events over real Redis on every state
# transition (`_set_state` -> `events.publish_import_event_sync`) -- needs
# the session-scoped Redis testcontainer up before the FIRST test in this
# module runs the task, same as `tests/test_scanner.py`'s module-wide
# `usefixtures("redis_url")` (this module would otherwise only pass by
# accident of file ordering, when some other test file's `client` fixture
# happens to have started the container first).
pytestmark = pytest.mark.usefixtures("redis_url")


@pytest.mark.asyncio
async def test_download_failure_marks_failed_no_orphan_rows(
    db_session, library_root, data_dir, monkeypatch
):
    # A fake whose list_files advertises a file the transport 404s.
    fake = FakeImporter(files={"ghost.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)  # eager, sync

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


@pytest.mark.asyncio
async def test_download_failure_never_leaks_url_or_token_to_error_or_logs(
    db_session, library_root, data_dir, monkeypatch, caplog
):
    """FIX 1 (Critical): a real importer's resolved download URL can carry a
    signed token / access code. ``httpx.HTTPStatusError``'s own ``str()``
    echoes the full URL it hit -- that must never land in ``imports.error``
    nor in any log line."""
    fake = FakeImporter(files={"secret.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)
    monkeypatch.setattr(
        fake,
        "resolve_download",
        lambda external_id, f: ResolvedDownload(
            url=f"{FAKE_DL}secret.stl?token=SECRETTOKEN123", filename=f.filename
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    with caplog.at_level(logging.WARNING, logger="app.tasks.importing"):
        import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    assert imp.error is not None
    assert "SECRETTOKEN123" not in imp.error
    assert "SECRETTOKEN123" not in caplog.text


@pytest.mark.asyncio
async def test_publish_failure_does_not_revert_a_successful_import(
    db_session, library_root, data_dir, fake_import, monkeypatch, caplog
):
    """FIX 2 (Critical): the DONE publish is best-effort -- a Redis blip
    during the final ``_set_state`` must not unwind an already-committed
    successful import into an orphaned model + a FAILED row."""
    fake_import.files = {"cube.stl": corpus.box_stl()}
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    def flaky_publish(redis_url, import_id, state):
        raise RuntimeError("simulated redis publish failure")

    monkeypatch.setattr(events, "publish_import_event_sync", flaky_publish)

    with caplog.at_level(logging.WARNING, logger="app.tasks.importing"):
        import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.DONE
    assert imp.model_id is not None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1


@pytest.mark.asyncio
async def test_mid_download_failure_after_one_file_staged_leaves_no_orphans(
    db_session, library_root, data_dir, monkeypatch
):
    """FIX 3 (Important): a single-file 404 never proves the "file 1
    streamed, file 2 fails" ordering nor the spool-cleanup branch. Use a
    2-file fake: file A streams for real, file B 404s mid-loop."""
    fake = FakeImporter(files={"a.stl": corpus.box_stl(), "b.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        name = str(request.url).removeprefix(FAKE_DL)
        if name == "a.stl":
            return httpx.Response(200, content=fake.files["a.stl"])
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )

    staged_paths = []
    original_stream = download.stream_remote_to_spool

    def spying_stream(*args, **kwargs):
        result = original_stream(*args, **kwargs)
        staged_paths.append(result.spool_path)
        return result

    monkeypatch.setattr(download, "stream_remote_to_spool", spying_stream)

    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    assert len(staged_paths) == 1  # file A staged before file B's 404 aborted the loop
    assert not staged_paths[0].exists()  # the failure path must clean up staged spool files
    model_count = await db_session.scalar(select(func.count()).select_from(Model))
    revision_count = await db_session.scalar(select(func.count()).select_from(Revision))
    file_count = await db_session.scalar(select(func.count()).select_from(File))
    assert model_count == 0 and revision_count == 0 and file_count == 0


@pytest.mark.asyncio
async def test_store_failure_after_model_created_leaves_no_orphan_model(
    db_session, library_root, data_dir, fake_import, monkeypatch
):
    """FIX 4 (harden): ``create_imported_model_sync`` commits Model+Revision
    before the per-file store loop runs -- a failure there must not leave a
    committed orphan Model+Revision behind."""
    fake_import.files = {"cube.stl": corpus.box_stl()}

    def failing_store(*args, **kwargs):
        raise RuntimeError("simulated store failure")

    monkeypatch.setattr(library, "store_imported_file_sync", failing_store)

    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    model_count = await db_session.scalar(select(func.count()).select_from(Model))
    revision_count = await db_session.scalar(select(func.count()).select_from(Revision))
    assert model_count == 0 and revision_count == 0


# ---------------------------------------------------------------------------
# M6 Task 4 (B1): re-entry idempotency under Celery `acks_late` redelivery.
# A worker SIGKILLed mid-import never runs its `except` cleanup -- Celery
# redelivers the same message and the redelivered attempt must not duplicate
# the model nor leave the first one orphaned.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_crash_between_model_create_and_link_leaves_no_orphan(
    db_session, library_root, data_dir, fake_import, monkeypatch
):
    """Dedicated-review defect fix: phase (c) used to commit the new Model+
    Revision INSIDE ``create_imported_model_sync`` and only link
    ``imports.model_id`` in a SEPARATE, later commit -- an interruption
    landing between those two commits left a fully-committed Model that no
    redelivery guard could distinguish from a legitimate one still being
    linked (``imports.model_id`` reads NULL either way). Simulate exactly
    that interruption point -- right after the model/revision work
    completes, before the caller sets ``imp.model_id`` and commits -- via a
    spy that calls the real helper through to completion and then raises.
    Pre-fix this leaves a committed orphan Model (this test is RED against
    HEAD); post-fix (model creation no longer commits on its own -- the
    caller commits Model+link together) it leaves ZERO trace."""
    fake_import.files = {"cube.stl": corpus.box_stl()}
    original = library.create_imported_model_sync

    def crash_after_create(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("simulated crash between model create and imp.model_id link")

    monkeypatch.setattr(library, "create_imported_model_sync", crash_after_create)

    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0  # no orphan Model left behind by the interrupted commit


@pytest.mark.asyncio
async def test_redelivery_after_partial_commit_creates_no_duplicate(
    fake_import, data_dir, library_root
):
    """Fabricates the EXACT post-crash DB state the early link is designed
    to make detectable: a model + revision already committed AND
    ``imp.model_id`` already linked to it (the early-link commit that now
    happens immediately after model creation), but state still DOWNLOADING
    because the worker died before the per-file store loop / DONE commit
    ran.

    NOTE (deviation from the brief's Step 1 snippet): the brief's snippet
    leaves ``imp.model_id`` NULL here, describing the fabricated state as
    "worker died between the model commit and the link commit" -- that was
    the *pre-fix* window (model_id set only after the whole store loop, at
    the very end). With the early link in place, that exact combination
    ("files already committed" AND "model_id still NULL") can no longer
    arise from this task's own code, since files are only stored *after*
    the early-link commit. There is also no other durable, migration-free
    signal (no unique constraint on ``models.source_url``; slug collisions
    just get a numeric suffix, see ``_unique_slug_sync``) that could let a
    redelivery identify *this specific* orphan if ``model_id`` were NULL.
    Setting ``imp.model_id`` here instead accurately fabricates the window
    the fix actually closes (window 2, matching the entry guard's own
    ``imp.model_id is not None`` check and the dedicated-review checklist's
    "redelivery after partial phase-(c) commit ... window 2")."""
    from app.tasks.base import sync_session

    fake_import.files = {"cube.stl": corpus.box_stl()}
    with sync_session() as s:
        imp = Import(
            url="https://fake.test/thing/42",
            site=ImportSite.THINGIVERSE,
            external_id="42",
            state=ImportState.DOWNLOADING,
        )
        s.add(imp)
        s.commit()
        s.refresh(imp)
        import_id = imp.id
        backend = resolve_backend_sync(s, get_settings())
        orphan = library.create_imported_model_sync(
            s,
            backend,
            name="Fake Thing",
            description=None,
            source_url="x",
            source_site="thingiverse",
            source_author=None,
            source_license=None,
            imported_at=None,
            tags=[],
            initial_revision_name="imported",
        )
        orphan_id = orphan.id
        imp.model_id = orphan_id
        s.commit()

    import_from_url(import_id)  # redelivery: run the task again for the same import_id

    with sync_session() as s:
        assert s.query(Model).count() == 1  # the orphan was cleaned, not duplicated
        assert s.get(Model, orphan_id) is None  # stale model deleted
        imp = s.get(Import, import_id)
        assert imp.state == ImportState.DONE and imp.model_id is not None


@pytest.mark.asyncio
async def test_redelivery_ignored_while_lock_is_held(
    db_session, library_root, data_dir, fake_import, redis_url, monkeypatch
):
    """A genuinely concurrent redelivery (the original attempt is still
    in-flight and holds the per-import Redis lock) must be a clean no-op:
    the row is left untouched and the download path never runs a second
    time."""
    from app.tasks.importing import import_lock_key

    fake_import.files = {"cube.stl": corpus.box_stl()}
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    calls = []
    original_stream = download.stream_remote_to_spool

    def spying_stream(*args, **kwargs):
        calls.append((args, kwargs))
        return original_stream(*args, **kwargs)

    monkeypatch.setattr(download, "stream_remote_to_spool", spying_stream)

    client = aioredis.Redis.from_url(redis_url)
    await client.set(import_lock_key(imp.id), "some-other-worker-token")
    try:
        import_from_url(imp.id)
    finally:
        await client.delete(import_lock_key(imp.id))
        await client.aclose()

    assert calls == []  # stream_remote_to_spool never reached while the lock is held
    await db_session.refresh(imp)
    assert imp.state == ImportState.PENDING  # row untouched -- lock contention is a clean no-op
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


@pytest.mark.asyncio
async def test_redelivery_of_already_done_import_is_a_no_op(
    db_session, library_root, data_dir, fake_import
):
    """Direct coverage for the terminal-state entry guard (``imp.state in
    (DONE, FAILED): return``) -- previously only exercised indirectly. A
    DONE import redelivered (e.g. a duplicate broker message, or a
    redelivery racing a DONE that landed right before the ack) must be a
    pure no-op: state/model_id untouched, no second Model created."""
    from app.tasks.base import sync_session

    with sync_session() as s:
        backend = resolve_backend_sync(s, get_settings())
        model = library.create_imported_model_sync(
            s,
            backend,
            name="Already Done Vase",
            description=None,
            source_url="https://www.thingiverse.com/thing:1",
            source_site="thingiverse",
            source_author=None,
            source_license=None,
            imported_at=None,
            tags=[],
        )
        model_id = model.id

    imp = Import(
        url="https://fake.test/thing/1",
        site=ImportSite.THINGIVERSE,
        external_id="1",
        state=ImportState.DONE,
        model_id=model_id,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)
    import_id = imp.id

    import_from_url(import_id)  # redelivery of an already-terminal import

    await db_session.refresh(imp)
    assert imp.state == ImportState.DONE
    assert imp.model_id == model_id
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1  # no second model created


@pytest.mark.asyncio
async def test_redelivery_of_already_failed_import_is_a_no_op(db_session, library_root, data_dir):
    """Same guard, FAILED side -- a redelivered already-FAILED import must
    stay FAILED with no model_id and no Model created."""
    imp = Import(
        url="https://fake.test/thing/2",
        site=ImportSite.THINGIVERSE,
        external_id="2",
        state=ImportState.FAILED,
        error="some earlier failure",
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)
    import_id = imp.id

    import_from_url(import_id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED
    assert imp.model_id is None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0
