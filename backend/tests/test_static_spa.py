"""SPA static-file serving + client-side-routing fallback (Task 9, see
``app/static.py``). No DB/Redis needed here -- ``create_app()`` only touches
those inside the lifespan, which these tests never enter.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from app.config import get_settings
from app.main import create_app


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def static_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "static"
    root.mkdir()
    (root / "index.html").write_text("<html>spa shell</html>")
    assets = root / "assets"
    assets.mkdir()
    (assets / "app.js").write_text("console.log('hi');")
    monkeypatch.setenv("TDMM_STATIC_DIR", str(root))
    get_settings.cache_clear()
    return root


async def _client(app) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_serves_real_static_file(static_dir: Path) -> None:
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/assets/app.js")

    assert response.status_code == 200
    assert "console.log" in response.text


async def test_root_serves_index(static_dir: Path) -> None:
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/")

    assert response.status_code == 200
    assert "spa shell" in response.text


async def test_unknown_frontend_route_falls_back_to_index(static_dir: Path) -> None:
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/models/some-slug")

    assert response.status_code == 200
    assert "spa shell" in response.text


async def test_unmatched_api_path_stays_json_404_not_spa(static_dir: Path) -> None:
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/api/does-not-exist")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert "spa shell" not in response.text


async def test_path_traversal_falls_back_to_index_not_host_file(
    static_dir: Path, tmp_path: Path
) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me")

    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/../secret.txt")

    # httpx/starlette normalize `..` out of the URL path before routing ever
    # sees it, so this just exercises the ordinary fallback path -- the
    # traversal guard in `mount_spa` is defense in depth for any client that
    # sends a raw un-normalized path.
    assert response.status_code == 200
    assert "spa shell" in response.text


async def test_static_disabled_by_default() -> None:
    """No TDMM_STATIC_DIR set -- api_router's normal JSON 404 applies to
    everything outside /api, same as before Task 9.
    """
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/")

    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")


async def test_health_still_works_when_static_enabled(static_dir: Path) -> None:
    app = create_app()
    async with await _client(app) as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
