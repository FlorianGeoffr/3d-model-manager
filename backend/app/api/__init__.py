"""Aggregate API router mounted under ``/api`` by the app factory.

Split per the SPEC auth rule ("every /api route except /api/auth/login and
/api/health requires a valid session cookie"): ``health_router`` and
``auth.public_router`` stay outside any auth dependency, while
``protected_router`` carries a single router-level ``require_session``
dependency so everything included under it is auth-gated without
per-endpoint copy-paste. Later tasks add their routers to
``protected_router``, not to ``api_router`` directly.

``ext.router`` (M10 Workstream A: browser-extension endpoints) is the one
other exception -- it's mounted directly on ``api_router`` like
``health_router``/``auth.public_router`` above, but it is NOT unauthenticated:
it carries its own router-level ``require_api_token`` dependency (a separate,
narrowly-scoped bearer-token auth plane, deliberately kept independent of
``require_session`` -- see ``app.api.ext``'s module docstring).
"""

from fastapi import APIRouter, Depends

from app.api import (
    auth,
    blobs,
    collections,
    events,
    ext,
    features,
    files,
    imports,
    jobs,
    models,
    notes,
    print_jobs,
    printers,
    prints,
    queue,
    reports,
    revisions,
    scan,
    settings,
    tags,
    uploads,
)
from app.api.deps import require_session
from app.api.health import router as health_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(auth.public_router)
api_router.include_router(ext.router)

protected_router = APIRouter(dependencies=[Depends(require_session)])
protected_router.include_router(auth.protected_router)
protected_router.include_router(models.router)
protected_router.include_router(blobs.router)
protected_router.include_router(revisions.router)
protected_router.include_router(files.router)
protected_router.include_router(tags.router)
protected_router.include_router(notes.router)
protected_router.include_router(uploads.router)
protected_router.include_router(jobs.router)
protected_router.include_router(events.router)
protected_router.include_router(scan.router)
protected_router.include_router(settings.router)
protected_router.include_router(features.router)
protected_router.include_router(printers.router)
protected_router.include_router(print_jobs.router)
protected_router.include_router(prints.router)
protected_router.include_router(imports.router)
protected_router.include_router(collections.router)
protected_router.include_router(queue.router)
protected_router.include_router(reports.router)

api_router.include_router(protected_router)
