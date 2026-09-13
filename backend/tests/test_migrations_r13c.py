"""R13c migration (``f3a1c9d2e8b7``) round-trip safety: downgrade's narrowed
CHECK constraints against rows already widened into ``doc``/pdf|md|txt|docx,
and upgrade's one-time backfill of ``printers.build_volume_mm``.

Fully isolated from the rest of the suite: a scratch database is created in
the SAME testcontainer the session-scoped fixtures use (so no extra
container startup cost), migrated from scratch, exercised, and dropped --
never touching the shared ``migrated_db``/``db_session`` connections. Doing
alembic DDL against a database other tests hold open connections to
deadlocks (ALTER TABLE needs ACCESS EXCLUSIVE); a private database sidesteps
that entirely.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import anyio
import asyncpg
import pytest
from alembic.config import Config
from sqlalchemy.engine import make_url

from alembic import command
from app.config import get_settings

BACKEND_DIR = Path(__file__).resolve().parent.parent
_DOWN_REVISION = "2490bc11a7f5"


def _config() -> Config:
    return Config(str(BACKEND_DIR / "alembic.ini"))


async def _run_alembic(url: str, fn, revision: str) -> None:
    """Point ``app.config.get_settings().database_url`` (what
    ``alembic/env.py`` actually reads -- it ignores the Config object's own
    ``sqlalchemy.url``) at ``url`` for the duration of one alembic command,
    then restore it. ``fn`` runs in a worker thread since alembic's own
    ``env.py`` does ``asyncio.run(...)`` internally, which can't nest inside
    this (already-running) async test's event loop.
    """
    original = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    get_settings.cache_clear()
    try:
        await anyio.to_thread.run_sync(fn, _config(), revision)
    finally:
        if original is not None:
            os.environ["DATABASE_URL"] = original
        else:
            os.environ.pop("DATABASE_URL", None)
        get_settings.cache_clear()


@pytest.fixture
async def scratch_db(postgres_url: str):
    """A throwaway, unmigrated database in the same Postgres container,
    dropped again on teardown. Yields its asyncpg SQLAlchemy URL (for
    pointing alembic at) alongside a plain DSN (for direct asyncpg use).
    """
    base = make_url(postgres_url)
    name = f"r13c_mig_{uuid.uuid4().hex[:12]}"
    admin_dsn = base.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False
    )

    admin_conn = await asyncpg.connect(admin_dsn)
    try:
        await admin_conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await admin_conn.close()

    sa_url = base.set(database=name).render_as_string(hide_password=False)
    dsn = base.set(drivername="postgresql", database=name).render_as_string(hide_password=False)
    try:
        yield sa_url, dsn
    finally:
        admin_conn = await asyncpg.connect(admin_dsn)
        try:
            await admin_conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            await admin_conn.close()


async def test_downgrade_and_upgrade_round_trip(scratch_db: tuple[str, str]) -> None:
    sa_url, dsn = scratch_db

    await _run_alembic(sa_url, command.upgrade, "head")

    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(
            "INSERT INTO blobs (hash, size, kind, format) VALUES ($1, 10, 'doc', 'pdf')",
            "a" * 64,
        )
        await conn.execute(
            "INSERT INTO printers (name, kind, host, serial, access_code_enc, model) "
            "VALUES ('mini', 'bambu_lan', '1.2.3.4', 'ABCDEF0309ABC', 'enc', "
            "'Bambu Lab A1 mini')"
        )
        await conn.execute(
            "INSERT INTO printers (name, kind, host, serial, access_code_enc, model) "
            "VALUES ('unknown', 'bambu_lan', '1.2.3.5', 'ABCDEF0309ABD', 'enc', "
            "'Some Unknown Thing')"
        )
    finally:
        await conn.close()

    # Downgrade must collapse the doc blob to other/other BEFORE narrowing
    # the CHECK constraints -- if it didn't, this raises a constraint
    # violation instead of completing.
    await _run_alembic(sa_url, command.downgrade, _DOWN_REVISION)

    conn = await asyncpg.connect(dsn)
    try:
        kind, format_ = await conn.fetchrow(
            "SELECT kind, format FROM blobs WHERE hash = $1", "a" * 64
        )
        assert (kind, format_) == ("other", "other")
    finally:
        await conn.close()

    # Upgrading back must re-add build_volume_mm AND backfill it from each
    # row's existing `model` text (the column was just dropped by the
    # downgrade above, so this is exactly the pre-existing-row backfill
    # path, not the create-time seed).
    await _run_alembic(sa_url, command.upgrade, "head")

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch("SELECT model, build_volume_mm FROM printers")
    finally:
        await conn.close()

    by_model = {
        r["model"]: (json.loads(r["build_volume_mm"]) if r["build_volume_mm"] else None)
        for r in rows
    }
    assert by_model["Bambu Lab A1 mini"] == {"x": 180, "y": 180, "z": 180}
    assert by_model["Some Unknown Thing"] is None
