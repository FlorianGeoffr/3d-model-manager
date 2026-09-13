"""``created_at``/``print_count`` gallery sorts (R13b) -- exercises the
table-driven keyset-cursor refactor in ``app.services.library`` (Risk
resolution 7) with DUPLICATE sort keys, since a naive refactor could easily
break the ``(sort_col, id)`` tiebreak that makes ties safe to paginate
through.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.library import Model

pytestmark = pytest.mark.usefixtures("library_root")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _walk_all_pages(client: httpx.AsyncClient, *, sort: str, limit: int) -> list[int]:
    seen: list[int] = []
    cursor: str | None = None
    for _ in range(50):  # generous safety margin against an infinite loop
        url = f"/api/models?sort={sort}&limit={limit}"
        if cursor:
            url += f"&cursor={cursor}"
        response = await client.get(url)
        assert response.status_code == 200, response.text
        page = response.json()
        seen.extend(item["id"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    return seen


# ---------------------------------------------------------------------------
# created_at
# ---------------------------------------------------------------------------


async def test_gallery_sort_by_created_at_descending(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    older = await _create_model(authenticated_client, "Created Older")
    newer = await _create_model(authenticated_client, "Created Newer")

    row = await db_session.get(Model, older["id"])
    row.created_at = datetime(2020, 1, 1, tzinfo=UTC)
    await db_session.commit()

    response = await authenticated_client.get("/api/models?sort=-created_at&limit=10")

    ids = [item["id"] for item in response.json()["items"]]
    assert ids.index(newer["id"]) < ids.index(older["id"])


async def test_gallery_created_at_cursor_walk_with_duplicate_keys_across_three_pages(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    models = [await _create_model(authenticated_client, f"Created Dup {i}") for i in range(7)]

    # Force a real duplicate `created_at` across several rows -- otherwise
    # server-clock timestamps could coincidentally already be unique,
    # making the tiebreak path untested.
    shared = datetime(2026, 1, 1, tzinfo=UTC)
    for m in models[:5]:
        row = await db_session.get(Model, m["id"])
        row.created_at = shared
    await db_session.commit()

    seen = await _walk_all_pages(authenticated_client, sort="-created_at", limit=2)

    assert sorted(seen) == sorted(m["id"] for m in models)
    assert len(seen) == len(set(seen))


# ---------------------------------------------------------------------------
# print_count
# ---------------------------------------------------------------------------


async def test_gallery_sort_by_print_count_descending(
    authenticated_client: httpx.AsyncClient,
) -> None:
    quiet = await _create_model(authenticated_client, "Print Count Quiet")
    printed = await _create_model(authenticated_client, "Print Count Printed")
    for _ in range(3):
        r = await authenticated_client.post(f"/api/models/{printed['id']}/prints", json={})
        assert r.status_code == 201, r.text

    response = await authenticated_client.get("/api/models?sort=-print_count&limit=10")

    ids = [item["id"] for item in response.json()["items"]]
    assert ids.index(printed["id"]) < ids.index(quiet["id"])


async def test_gallery_print_count_cursor_walk_with_duplicate_keys_across_three_pages(
    authenticated_client: httpx.AsyncClient,
) -> None:
    models = [await _create_model(authenticated_client, f"Print Count Dup {i}") for i in range(7)]

    # Three models tied at print_count=2, the rest at the default 0 --
    # duplicate sort keys on both ends of the page walk.
    for m in models[:3]:
        for _ in range(2):
            r = await authenticated_client.post(f"/api/models/{m['id']}/prints", json={})
            assert r.status_code == 201, r.text

    seen = await _walk_all_pages(authenticated_client, sort="-print_count", limit=2)

    assert sorted(seen) == sorted(m["id"] for m in models)
    assert len(seen) == len(set(seen))


async def test_gallery_invalid_sort_field_is_400(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.get("/api/models?sort=bogus_field")

    assert response.status_code == 400
