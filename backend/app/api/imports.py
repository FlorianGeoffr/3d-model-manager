"""Gallery import endpoints (SPEC "API surface": imports (create/poll)).
POST detects the site from the URL, creates a ``pending`` Import row, and
dispatches ``import_from_url``; GET/{id} + list poll the row (the primary
read path -- richer than the generic jobs row). ``GET /search`` searches one
site or, with no ``site``, ALL registered sites concurrently (federated), so
the UI can browse-then-import instead of needing a URL up front. A deferred
site's URL (currently none -- see ``registry._DEFERRED_HOSTS``) would yield
a friendly 422, never a crash; an unsupported one always does."""

from __future__ import annotations

from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.importers.base import SEARCH_PAGE_SIZE, SearchResult
from app.importers.registry import (
    build_importer_for_url,
    deferred_site_for_url,
    get_importer,
    registered_sites,
)
from app.models.enums import ImportSite, ImportState
from app.models.system import Import
from app.schemas.imports import (
    ImportCreate,
    ImportOut,
    SearchResponse,
    SearchResultOut,
    SiteSearchStatus,
)
from app.tasks.importing import import_from_url

router = APIRouter(prefix="/imports", tags=["imports"])


@router.get("/search", response_model=SearchResponse)
async def search_imports(
    q: str,
    site: Annotated[list[ImportSite] | None, Query()] = None,
    page: int = 1,
) -> SearchResponse:
    """Search a chosen subset of sites (repeat ``?site=`` per site) or, when no
    ``site`` is given, ALL registered sites at once (federated). Each site is
    queried on its own worker thread so one slow or failing upstream can't stall
    or sink the others; results are merged and a per-site status row reports
    counts, likely-more, and errors."""
    q = q.strip()
    if not q:
        return SearchResponse(results=[], per_site=[])

    if site:
        # An explicit site with no importer stays a hard 422 (asking for a
        # specific unavailable site is an error); the federated (no-site) path
        # below instead just omits unregistered sites. Dedupe while preserving
        # the caller's order.
        sites = list(dict.fromkeys(site))
        for target in sites:
            if get_importer(target) is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, f"{target.value} isn't available"
                )
    else:
        sites = registered_sites()

    # Every importer's `search()` is fully BLOCKING (a sync httpx.Client with a
    # 30s timeout; Thingiverse/MakerWorld also open a blocking sync DB session
    # for their token, and MakerWorld may do a blocking Bambu token refresh).
    # Fan out one worker thread per site under a task group so a slow upstream
    # only delays itself, and catch per-site so one failure doesn't 500 the lot.
    hits_by_site: dict[ImportSite, list[SearchResult]] = {}
    errors_by_site: dict[ImportSite, str] = {}

    async def run_one(target: ImportSite) -> None:
        importer = get_importer(target)
        if importer is None:
            return
        try:
            hits_by_site[target] = await anyio.to_thread.run_sync(importer.search, q, page)
        except Exception as exc:  # noqa: BLE001 -- isolate one upstream's failure
            errors_by_site[target] = str(exc) or exc.__class__.__name__

    async with anyio.create_task_group() as tg:
        for target in sites:
            tg.start_soon(run_one, target)

    results: list[SearchResultOut] = []
    per_site: list[SiteSearchStatus] = []
    for target in sites:  # stable, site-grouped order
        hits = hits_by_site.get(target, [])
        results.extend(SearchResultOut.from_dataclass(r) for r in hits)
        if target in errors_by_site:
            per_site.append(
                SiteSearchStatus(
                    site=target.value, count=0, has_more=False, status="error",
                    detail=errors_by_site[target],
                )
            )
        else:
            per_site.append(
                SiteSearchStatus(
                    site=target.value,
                    count=len(hits),
                    has_more=len(hits) >= SEARCH_PAGE_SIZE,
                )
            )
    return SearchResponse(results=results, per_site=per_site)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ImportOut)
async def create_import(payload: ImportCreate, db: AsyncSession = Depends(get_db)) -> ImportOut:
    url = payload.url
    importer = build_importer_for_url(url)
    if importer is None:
        deferred = deferred_site_for_url(url)
        if deferred is not None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{deferred.value} import isn't available yet.",
            )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Unsupported URL -- paste a Thingiverse, Printables, or MakerWorld model link.",
        )
    external_id = importer.canonicalize(url)
    imp = Import(url=url, site=importer.site, external_id=external_id, state=ImportState.PENDING)
    db.add(imp)
    await db.commit()
    await db.refresh(imp)

    import_from_url.apply_async(args=[imp.id], task_id=f"import-{imp.id}")

    # Under eager Celery (tests) the line above ran the whole import inline
    # through its own SYNC session, driving the row to done/failed -- refresh
    # so this async session hands back the terminal state, not the stale
    # "pending" snapshot (same reasoning as app.api.settings.migrate).
    await db.refresh(imp)
    return ImportOut.from_model(imp)


@router.get("", response_model=list[ImportOut])
async def list_imports(limit: int = 50, db: AsyncSession = Depends(get_db)) -> list[ImportOut]:
    rows = (
        (await db.execute(select(Import).order_by(Import.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return [ImportOut.from_model(r) for r in rows]


@router.get("/{import_id}", response_model=ImportOut)
async def get_import(import_id: int, db: AsyncSession = Depends(get_db)) -> ImportOut:
    imp = await db.get(Import, import_id)
    if imp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"import {import_id} not found")
    return ImportOut.from_model(imp)
