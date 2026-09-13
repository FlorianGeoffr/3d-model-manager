"""``POST /api/models/{slug}/cover`` (R13a): raw-body PNG stream, shares the
``PUT /api/uploads`` tee-to-spool ingest path
(``app.services.spool.stream_to_spool`` -> ``library.finalize_upload`` ->
``store_to_backend``/pipeline dispatch). Celery runs in eager mode for the
whole test session (see ``conftest.py::_celery_eager_mode``), so by the time
the response comes back the file is already stored+verified and the thumb
pipeline has run.
"""

from __future__ import annotations

import zipfile
from io import BytesIO

import blake3
import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Blob, Derivative, File, Model, Revision
from app.models.enums import BlobFormat, BlobKind, DerivativeKind
from app.services import library
from tests.corpus import red_png

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _post_cover(client: httpx.AsyncClient, slug: str, content: bytes) -> httpx.Response:
    return await client.post(
        f"/api/models/{slug}/cover",
        content=content,
        headers={"content-type": "image/png"},
    )


async def test_set_cover_stores_blob_file_and_cover_hash(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "Cover Target")
    content = red_png()

    response = await _post_cover(authenticated_client, created["slug"], content)

    assert response.status_code == 200, response.text
    body = response.json()
    expected_hash = blake3.blake3(content).hexdigest()
    assert body["cover_blob_hash"] == expected_hash

    file_row = (
        await db_session.execute(select(File).where(File.blob_hash == expected_hash))
    ).scalar_one()
    assert file_row.rel_path == "_snapshots/cover.png"
    assert file_row.verified_at is not None

    model_row = await db_session.get(Model, created["id"])
    assert model_row.cover_blob_hash == expected_hash

    # Thumb pipeline ran (eager mode) for the new blob.
    derivative = (
        await db_session.execute(
            select(Derivative).where(
                Derivative.blob_hash == expected_hash,
                Derivative.kind == DerivativeKind.THUMB_256,
            )
        )
    ).scalar_one()
    assert derivative.status is not None


async def test_repost_replaces_cover_hash(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "Repost Cover Target")
    first = await _post_cover(authenticated_client, created["slug"], red_png())
    assert first.status_code == 200, first.text
    first_hash = first.json()["cover_blob_hash"]

    other_content = red_png() + b"\x00"  # different bytes -> different blob hash
    second = await _post_cover(authenticated_client, created["slug"], other_content)
    assert second.status_code == 200, second.text
    second_hash = second.json()["cover_blob_hash"]

    assert second_hash != first_hash

    detail = await authenticated_client.get(f"/api/models/{created['slug']}")
    assert detail.json()["cover_blob_hash"] == second_hash

    # Review fix: a repost must leave exactly ONE snapshot `File` row on the
    # revision -- not accumulate a new one per click.
    model = await library.get_model_by_slug(db_session, created["slug"])
    snapshot_files = (
        (
            await db_session.execute(
                select(File).where(
                    File.revision_id == model.current_revision_id,
                    File.rel_path == "_snapshots/cover.png",
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(snapshot_files) == 1
    assert snapshot_files[0].blob_hash == second_hash


async def test_set_cover_over_size_cap_is_413(authenticated_client: httpx.AsyncClient) -> None:
    created = await _create_model(authenticated_client, "Oversized Cover Target")

    oversized = b"\x00" * (20 * 1024 * 1024 + 1)
    response = await _post_cover(authenticated_client, created["slug"], oversized)

    assert response.status_code == 413


async def test_set_cover_empty_body_is_400(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "Empty Cover Target")

    response = await _post_cover(authenticated_client, created["slug"], b"")

    assert response.status_code == 400
    count = await db_session.scalar(select(func.count()).select_from(File))
    assert count == 0


async def test_set_cover_no_current_revision_is_409(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "No Revision Cover Target")
    model = await library.get_model_by_slug(db_session, created["slug"])
    model.current_revision_id = None
    await db_session.commit()

    response = await _post_cover(authenticated_client, created["slug"], red_png())

    assert response.status_code == 409


async def test_cover_snapshot_absent_from_files_listing_and_zip(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession, seed_file
) -> None:
    created = await _create_model(authenticated_client, "Snapshot Hidden Target")
    model = await library.get_model_by_slug(db_session, created["slug"])
    revision = await db_session.get(Revision, model.current_revision_id)
    await seed_file(model, revision, "part.stl", b"stl-bytes", blob_format=BlobFormat.STL)

    cover = await _post_cover(authenticated_client, created["slug"], red_png())
    assert cover.status_code == 200, cover.text

    detail = await authenticated_client.get(f"/api/models/{created['slug']}")
    file_paths = {f["rel_path"] for f in detail.json()["current_revision"]["files"]}
    assert file_paths == {"part.stl"}

    zip_response = await authenticated_client.get(f"/api/models/{created['slug']}/zip")
    assert zip_response.status_code == 200
    names = set(zipfile.ZipFile(BytesIO(zip_response.content)).namelist())
    assert names == {"snapshot-hidden-target/README.txt", "snapshot-hidden-target/part.stl"}


async def test_set_cover_bad_magic_bytes_is_400(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "Bad Magic Target")

    response = await _post_cover(authenticated_client, created["slug"], b"not-a-png" * 10)

    assert response.status_code == 400
    count = await db_session.scalar(select(func.count()).select_from(File))
    assert count == 0


async def test_set_cover_unknown_slug_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await _post_cover(authenticated_client, "no-such-model", red_png())

    assert response.status_code == 404


async def test_set_cover_infers_image_png_kind_format(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    created = await _create_model(authenticated_client, "Kind Format Target")
    content = red_png()

    response = await _post_cover(authenticated_client, created["slug"], content)
    assert response.status_code == 200, response.text

    blob_hash = response.json()["cover_blob_hash"]
    blob_row = await db_session.get(Blob, blob_hash)
    assert blob_row.kind == BlobKind.IMAGE
    assert blob_row.format == BlobFormat.PNG
