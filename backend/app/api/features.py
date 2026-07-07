"""Feature-flag probe (M4). Session-gated but NOT printer-gated: the
frontend reads it to decide whether to show the Printer nav / route, so it
must answer even when the printer feature is off.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings

router = APIRouter(tags=["features"])


@router.get("/features")
def get_features(settings: Settings = Depends(get_settings)) -> dict:
    return {"printer_enabled": settings.printer_enabled}
