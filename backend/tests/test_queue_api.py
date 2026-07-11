"""Print queue (Branch 4 Task 1): an ordered "models to print" worklist.

``GET /queue``/``POST /queue``/``DELETE /queue/{id}``/``PATCH /queue/{id}``.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.library import PrintQueueEntry

pytestmark = pytest.mark.usefixtures("library_root")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# append / idempotent re-add
# ---------------------------------------------------------------------------


async def test_enqueue_appends_at_end_with_incrementing_positions(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model_a = await _create_model(authenticated_client, "Queue A")
    model_b = await _create_model(authenticated_client, "Queue B")
    model_c = await _create_model(authenticated_client, "Queue C")

    for model in (model_a, model_b, model_c):
        response = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
        assert response.status_code == 201, response.text

    listing = await authenticated_client.get("/api/queue")
    assert listing.status_code == 200
    entries = listing.json()
    assert [e["position"] for e in entries] == [1, 2, 3]
    assert [e["model_id"] for e in entries] == [model_a["id"], model_b["id"], model_c["id"]]
    assert entries[0]["model"]["slug"] == model_a["slug"]


async def test_enqueue_unknown_model_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post("/api/queue", json={"model_id": 999999})

    assert response.status_code == 404


async def test_enqueue_already_queued_model_is_idempotent(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Queue Idempotent")

    first = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
    assert first.status_code == 201
    first_entry = first.json()

    second = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
    assert second.status_code == 200
    assert second.json() == first_entry

    listing = await authenticated_client.get("/api/queue")
    assert len(listing.json()) == 1


# ---------------------------------------------------------------------------
# delete + compaction
# ---------------------------------------------------------------------------


async def test_delete_entry_compacts_remaining_positions(
    authenticated_client: httpx.AsyncClient,
) -> None:
    models = [await _create_model(authenticated_client, f"Queue Delete {i}") for i in range(3)]
    entries = []
    for model in models:
        response = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
        entries.append(response.json())

    # Delete the middle entry (position 2).
    delete = await authenticated_client.delete(f"/api/queue/{entries[1]['id']}")
    assert delete.status_code == 204

    listing = await authenticated_client.get("/api/queue")
    remaining = listing.json()
    assert [e["position"] for e in remaining] == [1, 2]
    assert [e["model_id"] for e in remaining] == [models[0]["id"], models[2]["id"]]


async def test_delete_unknown_entry_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.delete("/api/queue/999999")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# reorder
# ---------------------------------------------------------------------------


async def test_patch_position_reorders_and_returns_full_list(
    authenticated_client: httpx.AsyncClient,
) -> None:
    models = [await _create_model(authenticated_client, f"Queue Reorder {i}") for i in range(3)]
    entries = []
    for model in models:
        response = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
        entries.append(response.json())

    # Move the last entry (position 3) to the front.
    response = await authenticated_client.patch(
        f"/api/queue/{entries[2]['id']}", json={"position": 1}
    )
    assert response.status_code == 200
    reordered = response.json()
    assert [e["model_id"] for e in reordered] == [
        models[2]["id"],
        models[0]["id"],
        models[1]["id"],
    ]
    assert [e["position"] for e in reordered] == [1, 2, 3]


async def test_patch_position_clamps_to_valid_range(
    authenticated_client: httpx.AsyncClient,
) -> None:
    models = [await _create_model(authenticated_client, f"Queue Clamp {i}") for i in range(2)]
    entries = []
    for model in models:
        response = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
        entries.append(response.json())

    too_high = await authenticated_client.patch(
        f"/api/queue/{entries[0]['id']}", json={"position": 999}
    )
    assert too_high.status_code == 200
    assert [e["model_id"] for e in too_high.json()] == [models[1]["id"], models[0]["id"]]

    too_low = await authenticated_client.patch(
        f"/api/queue/{entries[0]['id']}", json={"position": -5}
    )
    assert too_low.status_code == 200
    assert [e["model_id"] for e in too_low.json()] == [models[0]["id"], models[1]["id"]]


async def test_patch_unknown_entry_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.patch("/api/queue/999999", json={"position": 1})

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# model delete cascades the queue entry
# ---------------------------------------------------------------------------


async def test_model_hard_delete_cascades_the_queue_entry(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """M1 only supports soft-delete (archive) via the API -- the queue's
    ``ON DELETE CASCADE`` is exercised at the DB level directly (a raw SQL
    DELETE, since there is no hard-delete endpoint to drive it through HTTP).
    """
    model = await _create_model(authenticated_client, "Queue Cascade")
    enqueue = await authenticated_client.post("/api/queue", json={"model_id": model["id"]})
    assert enqueue.status_code == 201
    entry_id = enqueue.json()["id"]

    await db_session.execute(text("DELETE FROM models WHERE id = :id"), {"id": model["id"]})
    await db_session.commit()

    remaining = (
        await db_session.execute(select(PrintQueueEntry).where(PrintQueueEntry.id == entry_id))
    ).scalar_one_or_none()
    assert remaining is None
