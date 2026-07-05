"""FastAPI application factory and ASGI entrypoint (``app.main:app``)."""

from fastapi import FastAPI

from app.api import api_router
from app.logging_config import configure_logging


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    configure_logging()
    app = FastAPI(title="3D Model Manager")
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
