"""``GET /api/stats`` (R11-B item 13): dashboard aggregate counts.

Seeds a small dataset directly via the ORM (mirrors `seed_file`'s
direct-insert convention) and asserts each section of the response, plus
the 30s in-process cache TTL (`app.services.stats`).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.collections import FollowedCollection
from app.models.enums import BlobFormat, BlobKind, CollectionSyncMode, ImportSite, PrintResult
from app.models.library import Blob, File, Model, Print, Revision, Tag
from app.models.storage import StorageBackendRow
from app.models.system import Job
from app.services import stats as stats_service

pytestmark = pytest.mark.usefixtures("library_root")


async def _make_model(db: AsyncSession, name: str, **kwargs: object) -> Model:
    model = Model(slug=name.lower().replace(" ", "-"), name=name, **kwargs)
    db.add(model)
    await db.flush()
    return model


async def _make_file(
    db: AsyncSession, model: Model, digest: str, size: int, fmt: BlobFormat
) -> File:
    blob = await db.get(Blob, digest)
    if blob is None:
        blob = Blob(hash=digest, size=size, kind=BlobKind.MESH, format=fmt)
        db.add(blob)
        await db.flush()
    revision = Revision(model_id=model.id, number=1, dir_name="r1")
    db.add(revision)
    await db.flush()
    model.current_revision_id = revision.id

    default_backend = (
        await db.execute(select(StorageBackendRow).where(StorageBackendRow.is_default.is_(True)))
    ).scalar_one()
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path="model.stl",
        storage_path=f"{model.slug}/r1/model.stl",
        backend_id=default_backend.id,
    )
    db.add(file)
    await db.flush()
    return file


async def test_stats_sections(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    # A default backend row only gets lazily created on first real storage
    # access (`_ensure_default_backend_row`); seed one directly so the
    # by-backend breakdown below has something to join `files.backend_id`
    # against, same as a real install after its first write.
    db_session.add(
        StorageBackendRow(
            name="local", scheme="local", config={"backend": "local", "root": ""}, is_default=True
        )
    )
    await db_session.flush()

    # models: one draft (no revision), one with a file (favorite), one archived
    await _make_model(db_session, "Draft Model")
    with_file = await _make_model(db_session, "Filed Model", favorite=True)
    archived = await _make_model(db_session, "Archived Model", is_archived=True)
    await _make_file(db_session, with_file, "a" * 64, 1000, BlobFormat.STL)
    await _make_file(db_session, archived, "b" * 64, 2000, BlobFormat.THREEMF)

    db_session.add(Tag(name="one"))
    db_session.add(Tag(name="two"))

    db_session.add(
        FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="123",
            kind="collection",
            title="Some Collection",
            mode=CollectionSyncMode.AUTO,
        )
    )

    db_session.add(
        Print(
            model_id=with_file.id,
            result=PrintResult.SUCCESS,
            filament_g=50.5,
            duration_min=90,
        )
    )
    db_session.add(
        Print(
            model_id=with_file.id,
            result=PrintResult.FAIL,
            filament_g=10.0,
            duration_min=30,
        )
    )

    db_session.add(Job(id=uuid.uuid4(), type="scan_library", state="running"))
    db_session.add(Job(id=uuid.uuid4(), type="scan_library", state="queued"))
    db_session.add(
        Job(
            id=uuid.uuid4(),
            type="scan_library",
            state="failed",
            updated_at=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    await db_session.commit()

    response = await authenticated_client.get("/api/stats")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["models"] == {"total": 3, "favorites": 1, "archived": 1, "drafts": 1}

    assert body["files"]["total"] == 2
    assert body["files"]["bytes_total"] == 3000
    assert body["files"]["bytes_by_backend"] == {"local": 3000}
    assert body["files"]["by_format"] == {"stl": 1, "3mf": 1}

    assert body["tags"] == 2
    assert body["collections"] == 1

    assert body["prints"]["total"] == 2
    assert body["prints"]["succeeded"] == 1
    assert body["prints"]["failed"] == 1
    assert body["prints"]["filament_g_total"] == pytest.approx(60.5)
    assert body["prints"]["duration_s_total"] == 120 * 60

    assert body["recent"]["models_added_7d"] == 3
    assert body["recent"]["prints_7d"] == 2

    assert body["jobs"] == {"running": 1, "queued": 1, "failed_24h": 1}


async def test_stats_cache_ttl(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second request inside the 30s TTL reuses the cached result even
    though the underlying data changed; once the clock advances past the
    TTL, the next request recomputes."""
    stats_service._cache = None
    fake_time = [1000.0]
    monkeypatch.setattr(stats_service.time, "monotonic", lambda: fake_time[0])

    first = await authenticated_client.get("/api/stats")
    assert first.status_code == 200
    assert first.json()["tags"] == 0

    db_session.add(Tag(name="fresh"))
    await db_session.commit()

    fake_time[0] += 5  # still inside the 30s TTL
    cached = await authenticated_client.get("/api/stats")
    assert cached.json()["tags"] == 0

    fake_time[0] += 30  # past the TTL
    refreshed = await authenticated_client.get("/api/stats")
    assert refreshed.json()["tags"] == 1
