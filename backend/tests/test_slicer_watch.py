"""``app.tasks.slicer_watch.scan_slicer_watch`` (Round 8 Task 5: watched-
folder auto-import). Calls the task function directly, exactly like
``tests/test_import_from_url.py`` calls ``import_from_url`` -- a bound
``@celery_app.task`` object is callable as a plain function, so this never
needs a real broker round trip even outside eager mode.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from redis import Redis
from sqlalchemy import func, select

from app.config import Settings, get_settings
from app.models import File, Model
from app.services import library
from app.storage.local import LocalStorageBackend
from app.tasks.slicer_watch import (
    FAILED_DIRNAME,
    IMPORTED_DIRNAME,
    SLICER_WATCH_LOCK_KEY,
    scan_slicer_watch,
)

pytestmark = pytest.mark.usefixtures("library_root", "data_dir", "redis_url")


@pytest.fixture
def watch_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Points ``WATCH_DIR`` at a fresh tmp_path for this test,
    mirroring ``conftest.py``'s ``library_root``/``data_dir`` fixtures."""
    watch = tmp_path / "watch"
    watch.mkdir()
    monkeypatch.setenv("WATCH_DIR", str(watch))
    get_settings.cache_clear()
    yield watch
    get_settings.cache_clear()


def _age(path: Path, seconds: float) -> None:
    """Backdates ``path``'s mtime by ``seconds`` so the stability check
    (default ``watch_stable_s`` = 10s) treats it as no longer being
    written -- avoids a real sleep in the test."""
    old = time.time() - seconds
    os.utime(path, (old, old))


def test_settings_env_vars_map_to_short_watch_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """Round 9 dropped the app prefix and the unit suffixes from the
    env var names while the ``Settings`` fields kept their unit suffixes
    (``watch_interval_s``), bridged via per-field ``validation_alias``. A
    typo'd rename here would silently leave ``watch_dir``/``watch_interval_s``
    at their defaults and the watcher would never turn on -- this pins the
    env<->field mapping so a future rename can't do that unnoticed:
    suffix-less env ``WATCH_INTERVAL`` -> aliased field ``watch_interval_s``,
    and plain prefixless env ``PRINTER_ENABLED`` -> ``printer_enabled``."""
    monkeypatch.setenv("WATCH_DIR", "/tmp/x")
    monkeypatch.setenv("WATCH_INTERVAL", "30")
    monkeypatch.setenv("PRINTER_ENABLED", "true")

    settings = Settings()

    assert settings.watch_dir == Path("/tmp/x")
    assert settings.watch_interval_s == 30
    assert settings.printer_enabled is True


async def test_stable_supported_file_is_imported_and_moved(
    watch_dir: Path, db_session
) -> None:
    f = watch_dir / "Benchy_PLA_1h2m.gcode"
    f.write_bytes(b"stable-gcode-bytes" * 20)
    _age(f, 3600)

    scan_slicer_watch()

    assert not f.exists()
    assert (watch_dir / IMPORTED_DIRNAME / "Benchy_PLA_1h2m.gcode").exists()

    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1
    model = (await db_session.execute(select(Model))).scalar_one()
    assert model.name == "Benchy"
    files = (
        await db_session.execute(select(File).where(File.revision_id == model.current_revision_id))
    ).scalars().all()
    assert [file.rel_path for file in files] == ["Benchy_PLA_1h2m.gcode"]


async def test_fresh_file_is_left_in_place(watch_dir: Path, db_session) -> None:
    f = watch_dir / "Fresh_PLA_1h2m.gcode"
    f.write_bytes(b"fresh-gcode-bytes" * 20)  # mtime == now, well inside the default 10s window

    scan_slicer_watch()

    assert f.exists()
    assert not (watch_dir / IMPORTED_DIRNAME).exists()
    assert not (watch_dir / FAILED_DIRNAME).exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_fresh_unsupported_extension_file_is_left_in_place(
    watch_dir: Path, db_session
) -> None:
    """M1 fix-review: the stability gate must run BEFORE extension
    classification -- a file that doesn't (yet) look like a supported blob
    kind/format is still left alone while its mtime is inside the
    stability window, exactly like a supported one would be, instead of
    being yanked straight into `.failed/` regardless of age."""
    f = watch_dir / "notes.txt"
    f.write_text("just some notes")  # mtime == now, well inside the default 10s window

    scan_slicer_watch()

    assert f.exists()
    assert not (watch_dir / FAILED_DIRNAME).exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_temp_suffix_file_is_left_in_place_even_once_stable(
    watch_dir: Path, db_session
) -> None:
    """M1 fix-review: a sync tool's in-flight temp name (e.g. Syncthing's
    `~syncthing~Foo.gcode.3mf.tmp`) is skipped outright -- even once its
    mtime has stabilized, it's still under the tool's OWN in-progress
    naming convention and hasn't been atomically renamed to its final name
    yet, so it must never be pulled into `.failed/`."""
    f = watch_dir / "~syncthing~Benchy.gcode.3mf.tmp"
    f.write_bytes(b"still-syncing-bytes" * 20)
    _age(f, 3600)

    scan_slicer_watch()

    assert f.exists()
    assert not (watch_dir / FAILED_DIRNAME).exists()
    assert not (watch_dir / IMPORTED_DIRNAME).exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_matches_existing_model_name_case_insensitively(
    watch_dir: Path, db_session, backend: LocalStorageBackend
) -> None:
    model = await library.create_model(db_session, backend, name="Widget", description=None)

    f = watch_dir / "widget_PETG_45m.gcode"
    f.write_bytes(b"widget-gcode-bytes" * 20)
    _age(f, 3600)

    scan_slicer_watch()

    assert not f.exists()
    assert (watch_dir / IMPORTED_DIRNAME / "widget_PETG_45m.gcode").exists()

    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1  # attached to the existing model, no new one created
    files = (
        await db_session.execute(select(File).where(File.revision_id == model.current_revision_id))
    ).scalars().all()
    assert [file.rel_path for file in files] == ["widget_PETG_45m.gcode"]


async def test_unsupported_extension_is_moved_to_failed_no_model(
    watch_dir: Path, db_session
) -> None:
    f = watch_dir / "notes.txt"
    f.write_text("just some notes")
    _age(f, 3600)

    scan_slicer_watch()

    assert not f.exists()
    assert (watch_dir / FAILED_DIRNAME / "notes.txt").exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_entries_inside_terminal_dirs_are_never_touched(
    watch_dir: Path, db_session
) -> None:
    imported_dir = watch_dir / IMPORTED_DIRNAME
    imported_dir.mkdir()
    already_imported = imported_dir / "Already_PLA_1h2m.gcode"
    already_imported.write_bytes(b"already-imported-bytes" * 20)
    _age(already_imported, 3600)

    failed_dir = watch_dir / FAILED_DIRNAME
    failed_dir.mkdir()
    already_failed = failed_dir / "notes.txt"
    already_failed.write_text("already failed")

    scan_slicer_watch()

    assert already_imported.exists()  # untouched -- never re-scanned
    assert already_failed.exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_lock_held_returns_without_scanning(watch_dir: Path, db_session) -> None:
    f = watch_dir / "Locked_PLA_1h2m.gcode"
    f.write_bytes(b"locked-gcode-bytes" * 20)
    _age(f, 3600)

    settings = get_settings()
    client = Redis.from_url(settings.redis_url)
    client.set(SLICER_WATCH_LOCK_KEY, "some-other-worker-token")
    try:
        scan_slicer_watch()
    finally:
        client.delete(SLICER_WATCH_LOCK_KEY)

    assert f.exists()  # untouched -- the scan never ran while the lock was held
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


async def test_move_collision_gets_numeric_suffix_not_clobbered(
    watch_dir: Path, db_session
) -> None:
    imported_dir = watch_dir / IMPORTED_DIRNAME
    imported_dir.mkdir()
    prior = imported_dir / "Dup_PLA_1h2m.gcode"
    prior.write_bytes(b"prior-arrival-bytes")

    f = watch_dir / "Dup_PLA_1h2m.gcode"
    f.write_bytes(b"newly-imported-bytes" * 20)
    _age(f, 3600)

    scan_slicer_watch()

    assert not f.exists()
    assert prior.read_bytes() == b"prior-arrival-bytes"  # untouched, never clobbered
    assert (imported_dir / "Dup_PLA_1h2m (2).gcode").exists()
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1
