"""Application configuration.

Settings are loaded from environment variables prefixed with ``TDMM_`` (e.g.
``TDMM_DATABASE_URL``). See the M1 plan's Global Constraints for the full
list of supported variables.
"""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the tdmm backend."""

    model_config = SettingsConfigDict(env_prefix="TDMM_", extra="ignore")

    database_url: str = "postgresql+asyncpg://tdmm:tdmm@localhost:5432/tdmm"
    redis_url: str = "redis://localhost:6379/0"
    data_dir: Path = Path("./data")
    library_root: Path = Path("./library")
    admin_username: str = "admin"
    admin_password: SecretStr | None = None
    cookie_secure: bool = False
    # How often GET /api/events sends a `: ping` heartbeat comment while idle
    # (Task 6). Overridable so tests don't have to wait a real 15s.
    sse_heartbeat_interval_s: float = 15.0
    # Directory the built frontend (`web/dist`) lives in, e.g. `/app/static`
    # inside the Docker image (Task 9). `None` (the default) disables SPA
    # serving entirely -- local dev runs the Vite dev server instead, which
    # proxies `/api` to this backend (see README "Development").
    static_dir: Path | None = None
    # Path/name of the gltfpack executable (M2 "Processing pipeline":
    # `optimize_glb`/browser meshopt compression). Defaults to whatever
    # `gltfpack` resolves to on PATH (see tests/conftest.py, which prepends
    # the npm-installed WASM shim's bin dir for local dev/CI).
    gltfpack_path: str = "gltfpack"
    # Opt-in scheduled scan (SPEC "optional scheduled scan"; Task 5 brief):
    # seconds between automatic `scan_library` runs via Celery beat. `0`
    # (the default) means OFF -- see `app.tasks.celery_app`'s conditional
    # `beat_schedule`.
    scan_interval_s: int = 0
    # Opt-in periodic sync of followed remote collections/favourites (M8 H):
    # seconds between automatic `sync_collections.sync_all` runs via Celery
    # beat. `0` (the default) means OFF -- the "Sync now" button still works.
    collection_sync_interval_s: int = 0
    # Printer integration (SPEC "Printer integration"; M4). OFF by default:
    # the whole app is fully functional without it -- the printers API 503s,
    # printerd idles, and the frontend greys the Printer nav.
    printer_enabled: bool = False
    # Overrides the on-disk Fernet key at {data_dir}/secrets/printer.key when
    # set (e.g. to share one key across api/worker/printerd via env instead of
    # a shared volume). A urlsafe-base64 32-byte Fernet key.
    printer_key: SecretStr | None = None


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide cached :class:`Settings` instance."""
    return Settings()
