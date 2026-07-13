"""FastAPI application factory and ASGI entrypoint (``app.main:app``)."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from app.api import api_router
from app.config import get_settings
from app.db import get_sessionmaker
from app.logging_config import configure_logging
from app.services import spool
from app.services.app_config import get_app_config, seed_app_config, warn_ignored_env
from app.services.bootstrap import ensure_admin_user
from app.services.secrets_at_rest import reencrypt_secrets_at_rest
from app.static import mount_spa

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run first-run bootstrap (SPEC requirement 1), create the upload spool
    directory (Task 6), seed the DB-backed runtime feature settings from env
    (Round 10; a no-op once seeded) and warn about any now-ignored deprecated
    env var, and eagerly re-encrypt any legacy plaintext secret (M6 A1) --
    all once on startup.
    """
    spool.ensure_spool_dir(get_settings())
    async with get_sessionmaker()() as session:
        await ensure_admin_user(session)
        settings = get_settings()
        if await seed_app_config(session, settings):
            config = await get_app_config(session, settings)
            logger.info(
                "Seeded app settings from env: printer_enabled=%s scan_interval_s=%s "
                "collection_sync_interval_s=%s watch_interval_s=%s watch_stable_s=%s",
                config.printer_enabled,
                config.scan_interval_s,
                config.collection_sync_interval_s,
                config.watch_interval_s,
                config.watch_stable_s,
            )
        warn_ignored_env(logger)
        await reencrypt_secrets_at_rest(session, settings)
    yield


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    configure_logging()
    app = FastAPI(title="3D Model Manager", lifespan=lifespan)
    app.include_router(api_router, prefix="/api")

    # SPA static serving (Task 9): only when STATIC_DIR is set AND
    # actually has a built frontend in it. Registered last so its catch-all
    # route never shadows an api_router route.
    settings = get_settings()
    if settings.static_dir is not None:
        static_dir = Path(settings.static_dir)
        if (static_dir / "index.html").is_file():
            mount_spa(app, static_dir)
        else:
            logger.warning("STATIC_DIR=%s has no index.html; SPA serving disabled", static_dir)

    return app


app = create_app()
