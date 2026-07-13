"""Feature-flag probe (M4). Session-gated but NOT printer-gated: the
frontend reads it to decide whether to show the Printer nav / route, so it
must answer even when the printer feature is off.

Round 8 T6 adds the watched-folder slicer fields
(``app.tasks.slicer_watch``, Round 8 T5): ``slicer_watch_dir`` surfaces the
container path so Settings can show it (and note it maps to
``TDMM_SLICER_WATCH_HOST_DIR`` on the host); ``slicer_watch_enabled`` mirrors
the exact condition ``app.tasks.celery_app`` uses to register the beat entry
(dir set AND a positive poll interval) rather than re-deriving it in the
frontend.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings

router = APIRouter(tags=["features"])


@router.get("/features")
def get_features(settings: Settings = Depends(get_settings)) -> dict:
    return {
        "printer_enabled": settings.printer_enabled,
        "slicer_watch_dir": str(settings.slicer_watch_dir) if settings.slicer_watch_dir else None,
        "slicer_watch_enabled": settings.slicer_watch_dir is not None and settings.slicer_watch_interval_s > 0,
    }
