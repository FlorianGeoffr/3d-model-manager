"""``GET/PUT /api/settings/storage`` + ``POST /api/settings/storage/test`` +
``POST /api/settings/storage/migrate`` (Task 6 brief).

The migration mechanics themselves (copy+verify+cutover) are covered end to
end in ``tests/test_migrate_task.py`` -- this module only exercises the API
surface: config read/write with secret redaction, the connection-test probe
(success and soft-failure), and that ``POST /migrate`` dispatches a tracked
job.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def test_get_default_storage_settings_is_local(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/settings/storage")

    assert response.status_code == 200
    assert response.json() == {"backend": "local", "config": {"backend": "local"}}


async def test_put_s3_config_then_get_redacts_secret(
    authenticated_client: httpx.AsyncClient,
) -> None:
    payload = {
        "backend": "s3",
        "config": {
            "bucket": "my-bucket",
            "access_key": "AKIAEXAMPLE",
            "secret_key": "super-secret-value",
            "endpoint_url": "http://127.0.0.1:1",
            "prefix": "lib",
            "addressing": "path",
        },
    }

    put_response = await authenticated_client.put("/api/settings/storage", json=payload)

    assert put_response.status_code == 200, put_response.text
    put_body = put_response.json()
    assert put_body["backend"] == "s3"
    assert put_body["config"]["secret_key"] == "***"
    assert put_body["config"]["access_key"] == "AKIAEXAMPLE"

    get_response = await authenticated_client.get("/api/settings/storage")

    assert get_response.status_code == 200
    get_body = get_response.json()
    assert get_body["backend"] == "s3"
    assert get_body["config"]["secret_key"] == "***"
    assert get_body["config"]["bucket"] == "my-bucket"
    # The raw secret must never appear anywhere in the response body.
    assert "super-secret-value" not in get_response.text


async def test_put_rejects_invalid_config(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.put(
        "/api/settings/storage", json={"backend": "smb", "config": {"host": "h"}}
    )

    assert response.status_code == 422


async def test_connection_test_against_local_candidate_ok(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.post(
        "/api/settings/storage/test", json={"backend": "local", "config": {}}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["detail"]
    assert isinstance(body["latency_ms"], int)
    assert body["latency_ms"] >= 0


async def test_connection_test_against_dead_s3_endpoint_fails_soft(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.post(
        "/api/settings/storage/test",
        json={
            "backend": "s3",
            "config": {
                "bucket": "nope",
                "access_key": "x",
                "secret_key": "y",
                "endpoint_url": "http://127.0.0.1:1",
                "addressing": "path",
            },
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["detail"]


async def test_connection_test_never_persists_the_candidate(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await authenticated_client.post(
        "/api/settings/storage/test",
        json={
            "backend": "s3",
            "config": {
                "bucket": "nope",
                "access_key": "x",
                "secret_key": "y",
                "endpoint_url": "http://127.0.0.1:1",
                "addressing": "path",
            },
        },
    )

    get_response = await authenticated_client.get("/api/settings/storage")

    assert get_response.json()["backend"] == "local"


async def test_migrate_dispatches_tracked_job(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post(
        "/api/settings/storage/migrate", json={"backend": "local", "config": {}}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["type"] == "migrate_storage"
    assert body["id"]
    assert body["state"] in {"queued", "running", "done", "failed"}
