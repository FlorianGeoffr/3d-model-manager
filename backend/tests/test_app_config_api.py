"""Tests for the Round 10 DB-backed runtime feature settings: the service
(``app.services.app_config``) plus ``GET``/``PUT /settings/app``
(``app.api.settings``). Mirrors ``tests/test_import_tokens_api.py``'s
API-level coverage; nothing here is secret, so unlike that module there's no
redaction/merge-on-blank to exercise -- ``PUT`` is a full replace.
"""

from __future__ import annotations

import logging

import pytest

from app.config import get_settings
from app.models import Setting
from app.services import app_config
from app.tasks import base

_DEFAULTS = {
    "printer_enabled": False,
    "scan_interval_s": 0,
    "collection_sync_interval_s": 0,
    "watch_interval_s": 0,
    "watch_stable_s": 10.0,
}


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# API: GET/PUT /settings/app
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_with_no_row_falls_back_to_env(authenticated_client, monkeypatch):
    monkeypatch.setenv("SCAN_INTERVAL", "45")
    get_settings.cache_clear()

    r = await authenticated_client.get("/api/settings/app")
    assert r.status_code == 200
    body = r.json()
    assert body["scan_interval_s"] == 45
    assert body["printer_enabled"] is False
    assert body["watch_stable_s"] == 10.0


@pytest.mark.asyncio
async def test_put_persists_all_five_fields_and_get_reflects_them(authenticated_client):
    payload = {
        "printer_enabled": True,
        "scan_interval_s": 30,
        "collection_sync_interval_s": 60,
        "watch_interval_s": 15,
        "watch_stable_s": 5.5,
    }
    put = await authenticated_client.put("/api/settings/app", json=payload)
    assert put.status_code == 200
    assert put.json() == payload

    got = await authenticated_client.get("/api/settings/app")
    assert got.json() == payload


@pytest.mark.asyncio
async def test_put_interval_zero_is_accepted(authenticated_client):
    payload = {**_DEFAULTS, "scan_interval_s": 0, "watch_stable_s": 0}
    r = await authenticated_client.put("/api/settings/app", json=payload)
    assert r.status_code == 200
    assert r.json()["scan_interval_s"] == 0
    assert r.json()["watch_stable_s"] == 0


@pytest.mark.asyncio
async def test_put_negative_interval_is_422(authenticated_client):
    payload = {**_DEFAULTS, "scan_interval_s": -1}
    r = await authenticated_client.put("/api/settings/app", json=payload)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_negative_watch_stable_is_422(authenticated_client):
    payload = {**_DEFAULTS, "watch_stable_s": -0.5}
    r = await authenticated_client.put("/api/settings/app", json=payload)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_row_with_only_one_field_falls_back_to_env_for_the_rest(
    authenticated_client, db_session, monkeypatch
):
    monkeypatch.setenv("WATCH_INTERVAL", "20")
    get_settings.cache_clear()
    db_session.add(Setting(key="app", value={"printer_enabled": True}))
    await db_session.commit()

    r = await authenticated_client.get("/api/settings/app")
    body = r.json()
    assert body["printer_enabled"] is True  # from the row
    assert body["watch_interval_s"] == 20  # env fallback -- not in the row
    assert body["scan_interval_s"] == 0  # default fallback -- not in the row
    assert body["watch_stable_s"] == 10.0  # default fallback -- not in the row


# ---------------------------------------------------------------------------
# Service: get/set/seed + per-field resolve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_app_config_partial_row_resolves_per_field(db_session, monkeypatch):
    monkeypatch.setenv("COLLECTION_SYNC_INTERVAL", "99")
    get_settings.cache_clear()
    db_session.add(Setting(key="app", value={"printer_enabled": True}))
    await db_session.commit()

    config = await app_config.get_app_config(db_session, get_settings())
    assert config.printer_enabled is True
    assert config.collection_sync_interval_s == 99
    assert config.scan_interval_s == 0
    assert config.watch_interval_s == 0
    assert config.watch_stable_s == 10.0


@pytest.mark.asyncio
async def test_seed_app_config_inserts_from_env_once(db_session, monkeypatch):
    monkeypatch.setenv("PRINTER_ENABLED", "true")
    monkeypatch.setenv("SCAN_INTERVAL", "120")
    get_settings.cache_clear()

    seeded = await app_config.seed_app_config(db_session, get_settings())
    assert seeded is True

    row = await db_session.get(Setting, "app")
    assert row.value["printer_enabled"] is True
    assert row.value["scan_interval_s"] == 120

    seeded_again = await app_config.seed_app_config(db_session, get_settings())
    assert seeded_again is False


@pytest.mark.asyncio
async def test_seed_app_config_never_overwrites_a_user_edit(db_session):
    settings = get_settings()
    await app_config.seed_app_config(db_session, settings)

    edited = app_config.AppConfig(
        printer_enabled=True,
        scan_interval_s=7,
        collection_sync_interval_s=8,
        watch_interval_s=9,
        watch_stable_s=1.5,
    )
    await app_config.set_app_config(db_session, settings, edited)

    seeded_after_edit = await app_config.seed_app_config(db_session, settings)
    assert seeded_after_edit is False

    row = await db_session.get(Setting, "app")
    assert row.value == edited.model_dump()


# ---------------------------------------------------------------------------
# warn_ignored_env
# ---------------------------------------------------------------------------


def test_warn_ignored_env_logs_only_for_set_deprecated_vars(monkeypatch, caplog):
    for name in app_config.DEPRECATED_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SCAN_INTERVAL", "45")

    log = logging.getLogger("app.services.app_config")
    with caplog.at_level(logging.WARNING, logger="app.services.app_config"):
        app_config.warn_ignored_env(log)

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "SCAN_INTERVAL" in warnings[0].getMessage()


def test_warn_ignored_env_is_silent_when_nothing_deprecated_is_set(monkeypatch, caplog):
    for name in app_config.DEPRECATED_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)

    log = logging.getLogger("app.services.app_config")
    with caplog.at_level(logging.WARNING, logger="app.services.app_config"):
        app_config.warn_ignored_env(log)

    assert caplog.records == []


# ---------------------------------------------------------------------------
# Sync twins (worker-side; mirrors app.services.storage_config's sync twins,
# exercised in tests/test_migrate_task.py via app.tasks.base.sync_session)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_twins_get_and_set(db_session, monkeypatch):
    monkeypatch.setenv("WATCH_INTERVAL", "33")
    get_settings.cache_clear()
    settings = get_settings()

    with base.sync_session() as s:
        config = app_config.get_app_config_sync(s, settings)
    assert config.watch_interval_s == 33

    edited = app_config.AppConfig(
        printer_enabled=True,
        scan_interval_s=1,
        collection_sync_interval_s=2,
        watch_interval_s=3,
        watch_stable_s=4.0,
    )
    with base.sync_session() as s:
        result = app_config.set_app_config_sync(s, settings, edited)
    assert result == edited

    row = await db_session.get(Setting, "app")
    assert row.value == edited.model_dump()
