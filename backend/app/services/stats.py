"""Dashboard stats aggregation (R11-B item 13: ``GET /api/stats``).

Every number here is a cheap SQL aggregate (``count``/``sum``/``group by``)
-- one query per section, no new tables. Results are cached in-process for
``CACHE_TTL_S`` seconds (a plain module-level tuple, since there's only ever
one possible response) so a dashboard poll -- or several browser tabs
polling at once -- can't hammer the DB; ``get_stats`` is the only entry
point and callers never see the cache directly.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.collections import FollowedCollection
from app.models.library import Blob, File, Model, Print, Tag
from app.models.storage import StorageBackendRow
from app.models.system import Job
from app.schemas.stats import (
    FilesStats,
    JobsStats,
    ModelsStats,
    PrintsStats,
    RecentStats,
    StatsOut,
)
from app.services import layout

CACHE_TTL_S = 30.0

# `(stats, computed_at_monotonic)` -- module-level so it's shared across
# every request in this process; `None` until the first computation.
_cache: tuple[StatsOut, float] | None = None


def reset_stats_cache() -> None:
    """Clear the in-process cache. Production code never needs this (the
    TTL handles staleness); it exists so tests can force a recompute
    instead of silently depending on run order to see an empty cache."""
    global _cache
    _cache = None


async def _models_stats(db: AsyncSession) -> ModelsStats:
    total, favorites, archived, drafts = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Model.favorite.is_(True)),
                func.count().filter(Model.is_archived.is_(True)),
                # A "draft" is a model with no revision snapshot yet -- the
                # scanner/import/upload paths all set `current_revision_id`
                # as soon as one exists, so NULL here means "created but
                # nothing attached yet".
                func.count().filter(Model.current_revision_id.is_(None)),
            ).select_from(Model)
        )
    ).one()
    return ModelsStats(total=total, favorites=favorites, archived=archived, drafts=drafts)


async def _files_stats(db: AsyncSession) -> FilesStats:
    # Internal snapshot files (the cover-image snapshot -- R13a review fix)
    # are never user content; exclude them from every total below, same as
    # the model detail/files listing and zip export.
    not_snapshot = ~File.rel_path.startswith(layout.SNAPSHOT_PREFIX)

    total, bytes_total = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Blob.size), 0))
            .select_from(File)
            .join(Blob, File.blob_hash == Blob.hash)
            .where(not_snapshot)
        )
    ).one()

    by_backend_rows = (
        await db.execute(
            select(StorageBackendRow.name, func.coalesce(func.sum(Blob.size), 0))
            .select_from(File)
            .join(Blob, File.blob_hash == Blob.hash)
            .join(StorageBackendRow, File.backend_id == StorageBackendRow.id)
            .where(not_snapshot)
            .group_by(StorageBackendRow.name)
        )
    ).all()

    by_format_rows = (
        await db.execute(
            select(Blob.format, func.count())
            .select_from(File)
            .join(Blob, File.blob_hash == Blob.hash)
            .where(not_snapshot)
            .group_by(Blob.format)
        )
    ).all()

    return FilesStats(
        total=total,
        bytes_total=int(bytes_total),
        bytes_by_backend={name: int(size) for name, size in by_backend_rows},
        by_format={str(fmt): count for fmt, count in by_format_rows},
    )


async def _prints_stats(db: AsyncSession) -> PrintsStats:
    total, succeeded, failed, filament_g_total, duration_min_total = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Print.result == "success"),
                func.count().filter(Print.result == "fail"),
                func.coalesce(func.sum(Print.filament_g), 0.0),
                func.coalesce(func.sum(Print.duration_min), 0),
            ).select_from(Print)
        )
    ).one()
    return PrintsStats(
        total=total,
        succeeded=succeeded,
        failed=failed,
        filament_g_total=float(filament_g_total),
        duration_s_total=int(duration_min_total) * 60,
    )


async def _recent_stats(db: AsyncSession) -> RecentStats:
    cutoff = datetime.now(UTC) - timedelta(days=7)
    models_added_7d = (
        await db.execute(select(func.count()).select_from(Model).where(Model.created_at >= cutoff))
    ).scalar_one()
    prints_7d = (
        await db.execute(select(func.count()).select_from(Print).where(Print.printed_at >= cutoff))
    ).scalar_one()
    return RecentStats(models_added_7d=models_added_7d, prints_7d=prints_7d)


async def _jobs_stats(db: AsyncSession) -> JobsStats:
    cutoff = datetime.now(UTC) - timedelta(hours=24)
    running, queued, failed_24h = (
        await db.execute(
            select(
                func.count().filter(Job.state == "running"),
                func.count().filter(Job.state == "queued"),
                func.count().filter(Job.state.in_(("failed", "dead")), Job.updated_at >= cutoff),
            ).select_from(Job)
        )
    ).one()
    return JobsStats(running=running, queued=queued, failed_24h=failed_24h)


async def _compute_stats(db: AsyncSession) -> StatsOut:
    models = await _models_stats(db)
    files = await _files_stats(db)
    tags = (await db.execute(select(func.count()).select_from(Tag))).scalar_one()
    collections = (
        await db.execute(select(func.count()).select_from(FollowedCollection))
    ).scalar_one()
    prints = await _prints_stats(db)
    recent = await _recent_stats(db)
    jobs = await _jobs_stats(db)

    return StatsOut(
        models=models,
        files=files,
        tags=tags,
        collections=collections,
        prints=prints,
        recent=recent,
        jobs=jobs,
    )


async def get_stats(db: AsyncSession) -> StatsOut:
    """Cached dashboard stats -- recomputed at most once every
    ``CACHE_TTL_S`` seconds process-wide."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[1] < CACHE_TTL_S:
        return _cache[0]
    stats = await _compute_stats(db)
    _cache = (stats, now)
    return stats
