import pytest

from app.models import Setting

_EMPTY = {"thingiverse_token": "", "makerworld_token": ""}
_BOTH_SET = {"thingiverse_token": "***", "makerworld_token": "***"}


@pytest.mark.asyncio
async def test_get_tokens_empty(authenticated_client):
    r = await authenticated_client.get("/api/settings/import-tokens")
    assert r.status_code == 200 and r.json() == _EMPTY


@pytest.mark.asyncio
async def test_put_and_mask_roundtrip(authenticated_client, db_session):
    put = await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "tok-abc-123", "makerworld_token": "AACB-mw-token"},
    )
    assert put.status_code == 200 and put.json() == _BOTH_SET
    # GET never returns the real token
    got = await authenticated_client.get("/api/settings/import-tokens")
    assert got.json() == _BOTH_SET

    # M6 A1: each token must be Fernet-encrypted at rest, not stored plaintext.
    row = await db_session.get(Setting, "import_tokens")
    assert row.value["thingiverse_token"] != "tok-abc-123"
    assert row.value["makerworld_token"] != "AACB-mw-token"


@pytest.mark.asyncio
async def test_blank_edit_keeps_stored(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "keepme", "makerworld_token": "keepme-too"},
    )
    # a blank submit must not wipe the stored tokens
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "", "makerworld_token": ""}
    )
    assert r.json() == _BOTH_SET


@pytest.mark.asyncio
async def test_sentinel_edit_keeps_stored(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "keepme", "makerworld_token": "keepme-too"},
    )
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "***", "makerworld_token": "***"}
    )
    assert r.json() == _BOTH_SET


@pytest.mark.asyncio
async def test_bare_sentinel_with_nothing_stored_is_422(authenticated_client):
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "***", "makerworld_token": ""}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_bare_sentinel_with_nothing_stored_is_422_for_makerworld(authenticated_client):
    r = await authenticated_client.put(
        "/api/settings/import-tokens", json={"thingiverse_token": "", "makerworld_token": "***"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_blank_put_with_nothing_stored_creates_no_setting_row(
    authenticated_client, db_session
):
    # Clearing tokens that were never stored is a true no-op: it must NOT
    # create a null `{"thingiverse_token": None, ...}` Setting row (M6 C3d).
    r = await authenticated_client.put("/api/settings/import-tokens", json=_EMPTY)
    assert r.status_code == 200 and r.json() == _EMPTY
    assert await db_session.get(Setting, "import_tokens") is None


@pytest.mark.asyncio
async def test_setting_thingiverse_token_preserves_makerworld_token(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "", "makerworld_token": "mw-tok"},
    )
    r = await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "tv-tok", "makerworld_token": ""},
    )
    assert r.status_code == 200 and r.json() == _BOTH_SET


@pytest.mark.asyncio
async def test_setting_makerworld_token_preserves_thingiverse_token(authenticated_client):
    await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "tv-tok", "makerworld_token": ""},
    )
    r = await authenticated_client.put(
        "/api/settings/import-tokens",
        json={"thingiverse_token": "", "makerworld_token": "mw-tok"},
    )
    assert r.status_code == 200 and r.json() == _BOTH_SET
