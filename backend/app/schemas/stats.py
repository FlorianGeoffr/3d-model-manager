"""Schemas for the dashboard stats API (R11-B item 13: ``GET /stats``)."""

from __future__ import annotations

from pydantic import BaseModel


class ModelsStats(BaseModel):
    total: int
    favorites: int
    archived: int
    drafts: int


class FilesStats(BaseModel):
    total: int
    bytes_total: int
    bytes_by_backend: dict[str, int]
    by_format: dict[str, int]


class PrintsStats(BaseModel):
    total: int
    succeeded: int
    failed: int
    filament_g_total: float
    duration_s_total: int


class RecentStats(BaseModel):
    models_added_7d: int
    prints_7d: int


class JobsStats(BaseModel):
    running: int
    queued: int
    failed_24h: int


class StatsOut(BaseModel):
    models: ModelsStats
    files: FilesStats
    tags: int
    collections: int
    prints: PrintsStats
    recent: RecentStats
    jobs: JobsStats
