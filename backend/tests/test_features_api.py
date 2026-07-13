"""``GET /api/features`` (M4 Task 4): session-gated but NOT printer-gated --
the frontend reads this to decide whether to show the Printer nav even when
the feature flag is off (SPEC "API surface").

Round 8 T6 adds the watched-folder slicer fields (`app.tasks.slicer_watch`,
Round 8 T5): `slicer_watch_dir` (the container path, or null) and
`slicer_watch_enabled` (dir set AND a positive poll interval -- the same
condition `app.tasks.celery_app` uses to register the beat entry).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.config import get_settings


async def test_features_disabled_by_default(authenticated_client):
    r = await authenticated_client.get("/api/features")
    assert r.status_code == 200 and r.json() == {
        "printer_enabled": False,
        "slicer_watch_dir": None,
        "slicer_watch_enabled": False,
    }


async def test_features_enabled(authenticated_client, printer_enabled):
    r = await authenticated_client.get("/api/features")
    assert r.json() == {
        "printer_enabled": True,
        "slicer_watch_dir": None,
        "slicer_watch_enabled": False,
    }


@pytest.fixture
def slicer_watch_configured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Sets both `TDMM_SLICER_WATCH_DIR` and a positive poll interval --
    mirrors `test_slicer_watch.py`'s `watch_dir` fixture, plus the interval
    the beat-entry condition also requires."""
    watch = tmp_path / "watch"
    watch.mkdir()
    monkeypatch.setenv("TDMM_SLICER_WATCH_DIR", str(watch))
    monkeypatch.setenv("TDMM_SLICER_WATCH_INTERVAL_S", "30")
    get_settings.cache_clear()
    yield watch
    get_settings.cache_clear()


async def test_features_slicer_watch_enabled(authenticated_client, slicer_watch_configured):
    r = await authenticated_client.get("/api/features")
    body = r.json()
    assert body["slicer_watch_enabled"] is True
    assert body["slicer_watch_dir"] == str(slicer_watch_configured)


async def test_features_slicer_watch_dir_without_interval_stays_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, authenticated_client
):
    """A configured dir with the interval left at 0 (the default) must NOT
    report enabled -- mirrors the beat-entry condition in
    `app.tasks.celery_app`, which needs BOTH."""
    watch = tmp_path / "watch"
    watch.mkdir()
    monkeypatch.setenv("TDMM_SLICER_WATCH_DIR", str(watch))
    get_settings.cache_clear()

    r = await authenticated_client.get("/api/features")
    body = r.json()

    get_settings.cache_clear()
    assert body["slicer_watch_dir"] == str(watch)
    assert body["slicer_watch_enabled"] is False
