import httpx
import pytest
from sqlalchemy import func, select

from app.importers import download
from app.importers.fake import FakeImporter
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportSite, ImportState
from app.models.library import Model
from app.models.system import Import
from app.tasks.importing import import_from_url


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
