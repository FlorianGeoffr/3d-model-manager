"""Unauthenticated liveness endpoint."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    """Report that the service is up. No auth required."""
    return {"status": "ok"}
