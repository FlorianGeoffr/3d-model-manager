"""Service-level coverage for ``app.services.import_tokens`` (task A5): two
independent Fernet-encrypted token fields sharing one ``Setting`` row, each
settable/clearable without disturbing the other. The API-level merge-on-
blank/sentinel behaviour is covered separately in ``test_import_tokens_api.py``.
"""

import pytest

from app.config import get_settings
from app.models import Setting
from app.services.import_tokens import (
    get_import_tokens,
    set_import_tokens,
    set_thingiverse_token,
)


@pytest.mark.asyncio
async def test_makerworld_token_round_trips_encrypted(db_session):
    s = get_settings()
    await set_import_tokens(
        db_session, s, thingiverse_token=None, makerworld_token="AACB-mw-secret"
    )

    row = await db_session.get(Setting, "import_tokens")
    assert row.value["makerworld_token"] != "AACB-mw-secret"  # ciphertext at rest

    tokens = await get_import_tokens(db_session, s)
    assert tokens.makerworld_token == "AACB-mw-secret"  # decrypts on read
    assert tokens.thingiverse_token is None


@pytest.mark.asyncio
async def test_setting_makerworld_token_preserves_thingiverse_token(db_session):
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token="tv-tok", makerworld_token=None)
    await set_import_tokens(db_session, s, thingiverse_token=None, makerworld_token="mw-tok")

    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token is None
    assert tokens.makerworld_token == "mw-tok"

    # the row itself must still carry BOTH keys, not just the one just written
    row = await db_session.get(Setting, "import_tokens")
    assert set(row.value.keys()) == {"thingiverse_token", "makerworld_token"}


@pytest.mark.asyncio
async def test_setting_thingiverse_token_preserves_makerworld_token(db_session):
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token=None, makerworld_token="mw-tok")
    await set_import_tokens(db_session, s, thingiverse_token="tv-tok", makerworld_token=None)

    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token == "tv-tok"
    assert tokens.makerworld_token is None


@pytest.mark.asyncio
async def test_clearing_one_field_preserves_the_other(db_session):
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token="tv-tok", makerworld_token="mw-tok")

    # explicit clear of ONE field only
    await set_import_tokens(db_session, s, thingiverse_token=None, makerworld_token="mw-tok")
    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token is None
    assert tokens.makerworld_token == "mw-tok"


@pytest.mark.asyncio
async def test_thin_wrapper_set_thingiverse_token_preserves_makerworld_token(db_session):
    """``set_thingiverse_token`` is kept as a thin wrapper -- it must still
    read the current row and delegate to ``set_import_tokens`` rather than
    clobbering ``makerworld_token`` with ``None``."""
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token=None, makerworld_token="mw-tok")

    await set_thingiverse_token(db_session, s, "tv-tok")

    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token == "tv-tok"
    assert tokens.makerworld_token == "mw-tok"


@pytest.mark.asyncio
async def test_all_none_with_no_row_writes_nothing(db_session):
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token=None, makerworld_token=None)
    assert await db_session.get(Setting, "import_tokens") is None


@pytest.mark.asyncio
async def test_legacy_plaintext_reads_back_for_both_fields_independently(db_session):
    s = get_settings()
    # simulate a pre-A5 (or hand-edited) row carrying plaintext in one or
    # both fields -- each field's InvalidToken fallback must be independent,
    # so a bad/plaintext value in one never blows up reading the other.
    db_session.add(
        Setting(
            key="import_tokens",
            value={"thingiverse_token": "plain-tv", "makerworld_token": "plain-mw"},
        )
    )
    await db_session.commit()

    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token == "plain-tv"
    assert tokens.makerworld_token == "plain-mw"


@pytest.mark.asyncio
async def test_legacy_plaintext_in_one_field_does_not_break_the_other(db_session):
    s = get_settings()
    await set_import_tokens(db_session, s, thingiverse_token="tv-tok", makerworld_token=None)
    row = await db_session.get(Setting, "import_tokens")
    # hand-corrupt just makerworld_token to plaintext alongside the already-
    # encrypted thingiverse_token
    row.value = {**row.value, "makerworld_token": "plain-mw"}
    await db_session.commit()

    tokens = await get_import_tokens(db_session, s)
    assert tokens.thingiverse_token == "tv-tok"  # still decrypts fine
    assert tokens.makerworld_token == "plain-mw"  # legacy-plaintext fallback
