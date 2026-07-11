"""``POST/GET /api/settings/api-tokens`` + ``DELETE /api/settings/api-tokens/
{id}`` (M10 Workstream A): session-gated management of the browser-extension
bearer tokens. The plaintext token must appear ONLY in the mint response;
GET must never carry the token or its hash.
"""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def test_mint_returns_token_once(authenticated_client: httpx.AsyncClient):
    r = await authenticated_client.post("/api/settings/api-tokens", json={"label": "Chrome ext"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["label"] == "Chrome ext"
    assert isinstance(body["token"], str) and len(body["token"]) > 20
    assert "id" in body and "created_at" in body


async def test_get_never_contains_token_or_hash(authenticated_client: httpx.AsyncClient):
    minted = await authenticated_client.post(
        "/api/settings/api-tokens", json={"label": "Chrome ext"}
    )
    token = minted.json()["token"]

    r = await authenticated_client.get("/api/settings/api-tokens")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    row = body[0]
    assert row["label"] == "Chrome ext"
    assert "token" not in row and "token_hash" not in row
    assert token not in r.text  # the plaintext never leaks into this response


async def test_get_lists_last_used_at_and_created_at(authenticated_client: httpx.AsyncClient):
    await authenticated_client.post("/api/settings/api-tokens", json={"label": "ext"})

    r = await authenticated_client.get("/api/settings/api-tokens")
    row = r.json()[0]
    assert row["last_used_at"] is None
    assert row["created_at"] is not None


async def test_delete_revokes_the_token(authenticated_client: httpx.AsyncClient):
    minted = await authenticated_client.post(
        "/api/settings/api-tokens", json={"label": "Chrome ext"}
    )
    token_id = minted.json()["id"]

    r = await authenticated_client.delete(f"/api/settings/api-tokens/{token_id}")
    assert r.status_code == 204

    listed = await authenticated_client.get("/api/settings/api-tokens")
    assert listed.json() == []


async def test_delete_unknown_id_is_404(authenticated_client: httpx.AsyncClient):
    r = await authenticated_client.delete("/api/settings/api-tokens/999999")
    assert r.status_code == 404


async def test_label_is_required(authenticated_client: httpx.AsyncClient):
    r = await authenticated_client.post("/api/settings/api-tokens", json={"label": ""})
    assert r.status_code == 422


async def test_endpoints_require_session(client: httpx.AsyncClient):
    assert (await client.get("/api/settings/api-tokens")).status_code == 401
    assert (await client.post("/api/settings/api-tokens", json={"label": "x"})).status_code == 401
    assert (await client.delete("/api/settings/api-tokens/1")).status_code == 401
