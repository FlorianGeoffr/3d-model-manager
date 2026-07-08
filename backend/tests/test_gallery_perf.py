"""D1 (Task 7 brief): the scaling risk in ``list_models`` isn't N+1 -- it's
already a fixed 5 queries/page (SPEC review) -- it's missing indexes behind
the keyset sorts and the ``tag``/``format``/``has_sliced`` filters. Seed a
1k-model gallery via the bulk Core-insert harness (``tests.gallery_seed``,
no storage side effects, no 1000-POST wall-clock cost) and assert each
representative gallery call stays comfortably under a CI-safe 1s bound.
"""

import time

import httpx
import pytest
from sqlalchemy import func, select

from app.models import Model
from app.tasks.base import sync_session
from tests.gallery_seed import bulk_seed_models


@pytest.mark.asyncio
async def test_1k_model_gallery_under_1s(authenticated_client: httpx.AsyncClient) -> None:
    with sync_session() as s:
        bulk_seed_models(s, count=1000, tags=5, with_sliced=100)
        # The harness itself, sanity-checked: exactly 1000 rows landed.
        assert s.execute(select(func.count()).select_from(Model)).scalar_one() == 1000

    for path in (
        "/api/models",
        "/api/models?q=model",
        "/api/models?tag=tag-1",
        "/api/models?format=stl",
        "/api/models?has_sliced=true",
        "/api/models?sort=name",
    ):
        t0 = time.perf_counter()
        response = await authenticated_client.get(path)
        elapsed = time.perf_counter() - t0

        assert response.status_code == 200, response.text
        body = response.json()
        assert len(body["items"]) > 0, f"{path} returned an empty first page"
        assert elapsed < 1.0, f"{path} took {elapsed:.3f}s (budget: 1.0s)"
