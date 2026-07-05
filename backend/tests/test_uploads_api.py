"""``PUT /api/uploads`` (SPEC "Upload flow", Task 6 interface decisions):
raw streamed body -> spool -> blob/file rows -> `store_to_backend` job.
Celery runs in eager mode for the whole test session (see
``conftest.py::_celery_eager_mode``), so by the time the PUT response comes
back the file is already stored and verified.
"""

from __future__ import annotations

import uuid

import blake3
import httpx
import pytest
from sqlalchemy import func, select

from app.models import Blob, File, Job
from app.storage.local import LocalStorageBackend

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(
    client: httpx.AsyncClient,
    *,
    model_id: int,
    revision_id: int,
    rel_path: str,
    content: bytes,
    replace: bool = False,
) -> httpx.Response:
    params = {"model_id": model_id, "revision_id": revision_id, "rel_path": rel_path}
    if replace:
        params["replace"] = "true"
    return await client.put("/api/uploads", params=params, content=content)


async def test_upload_creates_rows_stores_bytes_and_verifies(
    authenticated_client: httpx.AsyncClient,
    backend: LocalStorageBackend,
    data_dir,
) -> None:
    created = await _create_model(authenticated_client, "Upload Target")
    revision_id = created["current_revision"]["id"]
    content = b"binary-stl-bytes" * 1000

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="part.stl",
        content=content,
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["blob_hash"] == blake3.blake3(content).hexdigest()
    assert body["size"] == len(content)
    assert isinstance(body["file_id"], int)
    uuid.UUID(body["job_id"])  # well-formed uuid

    # Spool file is gone -- store_to_backend ran (eager mode) and cleaned up.
    spool_file = data_dir / "spool" / body["job_id"]
    assert not spool_file.exists()

    # Bytes landed at the correct layout path.
    assert b"".join(backend.read("upload-target/rev-001_initial/part.stl")) == content

    # File row verified, correct blob linkage.
    detail = await authenticated_client.get(f"/api/revisions/{revision_id}")
    file_out = next(f for f in detail.json()["files"] if f["rel_path"] == "part.stl")
    assert file_out["blob_hash"] == body["blob_hash"]
    assert file_out["verified_at"] is not None
    assert file_out["format"] == "stl"
    assert file_out["kind"] == "mesh"

    # Job row is done.
    jobs_resp = await authenticated_client.get("/api/jobs")
    job = next(j for j in jobs_resp.json() if j["id"] == body["job_id"])
    assert job["state"] == "done"
    assert job["type"] == "store_to_backend"
    assert job["subject_type"] == "file"
    assert job["subject_id"] == body["file_id"]
    assert job["attempts"] == 1


async def test_upload_rejects_empty_body(
    authenticated_client: httpx.AsyncClient, db_session, data_dir
) -> None:
    created = await _create_model(authenticated_client, "Empty Upload")
    revision_id = created["current_revision"]["id"]

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="empty.stl",
        content=b"",
    )

    assert response.status_code == 400
    count = await db_session.scalar(select(func.count()).select_from(File))
    assert count == 0
    # No orphaned spool file left behind by the rejected upload.
    spool_dir = data_dir / "spool"
    assert not spool_dir.exists() or list(spool_dir.iterdir()) == []


async def test_upload_to_non_current_revision_is_409(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Immutable Upload Target")
    rev1_id = created["current_revision"]["id"]
    await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=rev1_id,
        rel_path="part.stl",
        content=b"some-bytes",
    )

    assert response.status_code == 409


async def test_upload_rel_path_collision_without_replace_is_409(
    authenticated_client: httpx.AsyncClient,
    backend: LocalStorageBackend,
) -> None:
    created = await _create_model(authenticated_client, "Collision Target")
    revision_id = created["current_revision"]["id"]
    await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"original-bytes",
    )

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"new-bytes",
    )

    assert response.status_code == 409
    assert b"".join(backend.read("collision-target/rev-001_initial/a.stl")) == b"original-bytes"


async def test_upload_replace_true_overwrites_existing_file(
    authenticated_client: httpx.AsyncClient,
    backend: LocalStorageBackend,
    db_session,
) -> None:
    created = await _create_model(authenticated_client, "Replace Target")
    revision_id = created["current_revision"]["id"]
    await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"original-bytes",
    )

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"replacement-bytes",
        replace=True,
    )

    assert response.status_code == 201, response.text
    assert b"".join(backend.read("replace-target/rev-001_initial/a.stl")) == b"replacement-bytes"
    count = await db_session.scalar(
        select(func.count())
        .select_from(File)
        .where(File.revision_id == revision_id, File.rel_path == "a.stl")
    )
    assert count == 1


async def test_upload_duplicate_content_reuses_blob(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    created = await _create_model(authenticated_client, "Dedup Target")
    revision_id = created["current_revision"]["id"]
    content = b"identical-bytes-for-both-files"

    first = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="first.stl",
        content=content,
    )
    second = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="second.stl",
        content=content,
    )

    assert first.json()["blob_hash"] == second.json()["blob_hash"]
    count = await db_session.scalar(
        select(func.count()).select_from(Blob).where(Blob.hash == first.json()["blob_hash"])
    )
    assert count == 1


@pytest.mark.parametrize(
    "bad_rel_path",
    [
        "../escape.stl",
        "nested/../../escape.stl",
        "/absolute.stl",
        "back\\slash.stl",
        ".",
    ],
)
async def test_upload_unsafe_rel_path_is_400(
    authenticated_client: httpx.AsyncClient, bad_rel_path: str
) -> None:
    """``rel_path`` is user input that becomes a storage key -- traversal /
    absolute / backslash paths must be rejected up front (before any bytes
    are accepted), not left to explode later inside the Celery task with a
    poisoned ``files`` row already committed.
    """
    created = await _create_model(authenticated_client, f"Bad Path {bad_rel_path!r}")
    revision_id = created["current_revision"]["id"]

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path=bad_rel_path,
        content=b"whatever",
    )

    assert response.status_code == 400


async def test_upload_gcode_3mf_double_extension_infers_sliced(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Sliced Upload Target")
    revision_id = created["current_revision"]["id"]

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="print.gcode.3mf",
        content=b"fake-sliced-3mf-bytes",
    )

    assert response.status_code == 201
    detail = await authenticated_client.get(f"/api/revisions/{revision_id}")
    file_out = next(f for f in detail.json()["files"] if f["rel_path"] == "print.gcode.3mf")
    assert file_out["kind"] == "sliced"
    assert file_out["format"] == "gcode_3mf"


async def test_upload_job_id_equals_uuid_used_for_spool(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    created = await _create_model(authenticated_client, "Job Id Target")
    revision_id = created["current_revision"]["id"]

    response = await _upload(
        authenticated_client,
        model_id=created["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"some-bytes",
    )

    job_id = response.json()["job_id"]
    job = await db_session.get(Job, uuid.UUID(job_id))
    assert job is not None
    assert job.celery_id == job_id
