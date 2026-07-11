"""Duplicate-files report (Branch 4 Task 1): ``GET /reports/duplicates``
groups ``files`` rows by blob hash, keeping only hashes whose files span
more than one distinct model.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.library import File, Model, Revision

pytestmark = pytest.mark.usefixtures("library_root")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _model_and_revision(db_session: AsyncSession, payload: dict) -> tuple[Model, Revision]:
    model = await db_session.get(Model, payload["id"])
    revision = await db_session.get(Revision, model.current_revision_id)
    return model, revision


async def test_duplicate_group_across_two_models(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model_a = await _create_model(authenticated_client, "Duplicate A")
    model_b = await _create_model(authenticated_client, "Duplicate B")

    a, a_rev = await _model_and_revision(db_session, model_a)
    file_a = await seed_file(a, a_rev, "part.stl", b"shared-bytes")

    b, b_rev = await _model_and_revision(db_session, model_b)
    file_b = await seed_file(b, b_rev, "clone.stl", b"shared-bytes")

    assert file_a.blob_hash == file_b.blob_hash

    response = await authenticated_client.get("/api/reports/duplicates")
    assert response.status_code == 200
    body = response.json()

    assert len(body["groups"]) == 1
    group = body["groups"][0]
    assert group["blob_hash"] == file_a.blob_hash
    assert group["size"] == len(b"shared-bytes")
    assert group["wasted_bytes"] == len(b"shared-bytes")  # 2 files -> 1 wasted copy
    assert body["total_wasted_bytes"] == group["wasted_bytes"]

    file_entries = {(f["model_id"], f["file_name"]) for f in group["files"]}
    assert file_entries == {(model_a["id"], "part.stl"), (model_b["id"], "clone.stl")}
    for entry in group["files"]:
        if entry["model_id"] == model_a["id"]:
            assert entry["model_slug"] == model_a["slug"]
            assert entry["model_name"] == model_a["name"]
            assert entry["file_id"] == file_a.id


async def test_unique_blobs_are_excluded(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model = await _create_model(authenticated_client, "Unique Only")
    m, rev = await _model_and_revision(db_session, model)
    await seed_file(m, rev, "solo.stl", b"one-of-a-kind")

    response = await authenticated_client.get("/api/reports/duplicates")
    body = response.json()

    assert body["groups"] == []
    assert body["total_wasted_bytes"] == 0


async def test_same_model_two_files_sharing_hash_is_not_a_group(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    """A hash spanning two files that both belong to the SAME model doesn't
    count -- the report exists to find duplication ACROSS models.
    """
    model = await _create_model(authenticated_client, "Self Duplicate")
    m, rev = await _model_and_revision(db_session, model)
    await seed_file(m, rev, "a.stl", b"same-content-twice")
    await seed_file(m, rev, "b.stl", b"same-content-twice")

    response = await authenticated_client.get("/api/reports/duplicates")
    body = response.json()

    assert body["groups"] == []
    assert body["total_wasted_bytes"] == 0


async def test_groups_sorted_by_wasted_bytes_descending(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    small_a = await _create_model(authenticated_client, "Small A")
    small_b = await _create_model(authenticated_client, "Small B")
    big_a = await _create_model(authenticated_client, "Big A")
    big_b = await _create_model(authenticated_client, "Big B")
    big_c = await _create_model(authenticated_client, "Big C")

    sa_m, sa_rev = await _model_and_revision(db_session, small_a)
    await seed_file(sa_m, sa_rev, "s.stl", b"x" * 100)
    sb_m, sb_rev = await _model_and_revision(db_session, small_b)
    await seed_file(sb_m, sb_rev, "s.stl", b"x" * 100)

    ba_m, ba_rev = await _model_and_revision(db_session, big_a)
    await seed_file(ba_m, ba_rev, "b.stl", b"y" * 10000)
    bb_m, bb_rev = await _model_and_revision(db_session, big_b)
    await seed_file(bb_m, bb_rev, "b.stl", b"y" * 10000)
    bc_m, bc_rev = await _model_and_revision(db_session, big_c)
    await seed_file(bc_m, bc_rev, "b.stl", b"y" * 10000)

    response = await authenticated_client.get("/api/reports/duplicates")
    body = response.json()

    assert len(body["groups"]) == 2
    assert body["groups"][0]["wasted_bytes"] == 10000 * 2
    assert body["groups"][1]["wasted_bytes"] == 100 * 1
    assert body["groups"][0]["wasted_bytes"] > body["groups"][1]["wasted_bytes"]
    assert body["total_wasted_bytes"] == 10000 * 2 + 100 * 1
