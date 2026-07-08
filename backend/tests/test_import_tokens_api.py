import pytest

from app.models import Setting


@pytest.mark.asyncio
async def test_get_tokens_empty(authenticated_client):
    r = await authenticated_client.get("/api/settings/import-tokens")
    assert r.status_code == 200 and r.json() == {"thingiverse_token": ""}


@pytest.mark.asyncio
async def test_put_and_mask_roundtrip(authenticated_client, db_session):
    put = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "tok-abc-123"}
    )
    assert put.status_code == 200 and put.json() == {"thingiverse_token": "***"}
    # GET never returns the real token
    got = await authenticated_client.get("/api/settings/import-tokens")
    assert got.json() == {"thingiverse_token": "***"}

    # M6 A1: the token must be Fernet-encrypted at rest, not stored plaintext.
    row = await db_session.get(Setting, "import_tokens")
    assert row.value["thingiverse_token"] != "tok-abc-123"


@pytest.mark.asyncio
async def test_blank_edit_keeps_stored(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "keepme"}
    )
    # a blank submit must not wipe the stored token
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": ""}
    )
    assert r.json() == {"thingiverse_token": "***"}


@pytest.mark.asyncio
async def test_sentinel_edit_keeps_stored(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "keepme"}
    )
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "***"}
    )
    assert r.json() == {"thingiverse_token": "***"}


@pytest.mark.asyncio
async def test_bare_sentinel_with_nothing_stored_is_422(authenticated_client):
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "***"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_blank_put_with_nothing_stored_creates_no_setting_row(
    authenticated_client, db_session
):
    # Clearing a token that was never stored is a true no-op: it must NOT
    # create a null `{"thingiverse_token": None}` Setting row (M6 C3d).
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": ""}
    )
    assert r.status_code == 200 and r.json() == {"thingiverse_token": ""}
    assert await db_session.get(Setting, "import_tokens") is None
