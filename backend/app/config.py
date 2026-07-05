"""Application configuration.

Settings are loaded from environment variables prefixed with ``TDMM_`` (e.g.
``TDMM_DATABASE_URL``). See the M1 plan's Global Constraints for the full
list of supported variables.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the tdmm backend."""

    model_config = SettingsConfigDict(env_prefix="TDMM_", extra="ignore")

    database_url: str = "postgresql+asyncpg://tdmm:tdmm@localhost:5432/tdmm"
    redis_url: str = "redis://localhost:6379/0"
    data_dir: Path = Path("./data")
    library_root: Path = Path("./library")
    secret_key: str = "dev-insecure"
    admin_username: str = "admin"
    admin_password: str | None = None
    cookie_secure: bool = False
    # How often GET /api/events sends a `: ping` heartbeat comment while idle
    # (Task 6). Overridable so tests don't have to wait a real 15s.
    sse_heartbeat_interval_s: float = 15.0
    # Directory the built frontend (`web/dist`) lives in, e.g. `/app/static`
    # inside the Docker image (Task 9). `None` (the default) disables SPA
    # serving entirely -- local dev runs the Vite dev server instead, which
    # proxies `/api` to this backend (see README "Development").
    static_dir: Path | None = None


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide cached :class:`Settings` instance."""
    return Settings()
