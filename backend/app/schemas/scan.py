"""Response schema for ``POST /api/scan`` / ``GET /api/scan-runs`` (SPEC
``scan_runs``; Task 5 brief). Mirrors ``app.models.system.ScanRun`` 1:1.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from app.models import ScanRun


class ScanRunOut(BaseModel):
    id: int
    created_at: datetime
    finished_at: datetime | None
    state: str
    files_seen: int
    files_hashed: int
    relinked: int
    adopted: int
    missing: int
    report: dict | None

    @classmethod
    def from_model(cls, scan_run: ScanRun) -> ScanRunOut:
        return cls(
            id=scan_run.id,
            created_at=scan_run.created_at,
            finished_at=scan_run.finished_at,
            state=scan_run.state,
            files_seen=scan_run.files_seen,
            files_hashed=scan_run.files_hashed,
            relinked=scan_run.relinked,
            adopted=scan_run.adopted,
            missing=scan_run.missing,
            report=scan_run.report,
        )
