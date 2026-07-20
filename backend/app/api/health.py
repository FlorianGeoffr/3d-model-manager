"""Unauthenticated liveness endpoint."""

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings

router = APIRouter()


@router.get("/health")
async def health(settings: Settings = Depends(get_settings)) -> dict[str, str]:
    """Report that the service is up, and which build it is. No auth required.

    The version rides along on the *unauthenticated* endpoint on purpose:
    "which version is this deployment running" has to be answerable by an
    operator with nothing but curl, by a monitoring probe, and by the browser
    extension's "Test connection" -- none of which hold a session cookie. The
    value is the APP_VERSION baked into the image at build time (see
    docker/Dockerfile and ``app.config.Settings.app_version``); an unstamped
    image or a bare local ``uvicorn app.main:app`` reports ``dev``.
    """
    return {"status": "ok", "version": settings.app_version}
