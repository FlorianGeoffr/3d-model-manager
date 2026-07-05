"""FastAPI application factory and ASGI entrypoint (``app.main:app``)."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import api_router
from app.db import get_sessionmaker
from app.logging_config import configure_logging
from app.services.bootstrap import ensure_admin_user


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run first-run bootstrap (SPEC requirement 1) once on startup."""
    async with get_sessionmaker()() as session:
        await ensure_admin_user(session)
    yield


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    configure_logging()
    app = FastAPI(title="3D Model Manager", lifespan=lifespan)
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
