"""``GET /api/features`` (M4 Task 4): session-gated but NOT printer-gated --
the frontend reads this to decide whether to show the Printer nav even when
the feature flag is off (SPEC "API surface").
"""

from __future__ import annotations


async def test_features_disabled_by_default(authenticated_client):
    r = await authenticated_client.get("/api/features")
    assert r.status_code == 200 and r.json() == {"printer_enabled": False}


async def test_features_enabled(authenticated_client, printer_enabled):
    r = await authenticated_client.get("/api/features")
    assert r.json() == {"printer_enabled": True}
