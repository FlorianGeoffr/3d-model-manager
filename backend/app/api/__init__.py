"""Aggregate API router mounted under ``/api`` by the app factory.

Split per the SPEC auth rule ("every /api route except /api/auth/login and
/api/health requires a valid session cookie"): ``health_router`` and
``auth.public_router`` stay outside any auth dependency, while
``protected_router`` carries a single router-level ``require_session``
dependency so everything included under it is auth-gated without
per-endpoint copy-paste. Later tasks add their routers to
``protected_router``, not to ``api_router`` directly.
"""

from fastapi import APIRouter, Depends

from app.api import auth
from app.api.deps import require_session
from app.api.health import router as health_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth.public_router)

protected_router = APIRouter(dependencies=[Depends(require_session)])
protected_router.include_router(auth.protected_router)

api_router.include_router(protected_router)
