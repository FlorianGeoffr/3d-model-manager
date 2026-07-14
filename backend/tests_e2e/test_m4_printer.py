"""M4 printer e2e (Task 9): drives the flag-OFF safety path, then flips the
flag and drives the wizard/settings API + the send-flow preflight
rejections -- ALL without any printer hardware (the physical print start is
the deferred Manual/Live Acceptance below). Mirrors test_m3_scan.py's e2e
conventions.

I2 (Round 10 fix wave): the flag toggle used to rewrite `.env` +
`docker compose up -d --force-recreate api`, the same container-side idiom
test_m1_flow.py uses for a real restart. Round 10 made `printer_enabled`
DB-backed and live (`PUT /api/settings/app`, no restart) -- `PRINTER_ENABLED`
in `.env` now only *seeds* the row on first boot, so once the row exists a
later `.env` edit + recreate is silently ignored and the flag never flips.
`_set_printer_flag` now drives the live settings API instead, exercising the
no-restart flip that is R10's headline feature.
"""

from __future__ import annotations

import io
import os
import uuid
import zipfile

import httpx
import pytest

pytestmark = pytest.mark.e2e

BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8080")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")

CREATE = {
    "name": "E2E A1",
    "host": "10.255.255.1",
    "serial": "E2ESERIAL",
    "access_code": "12345678",
}


def _password() -> str:
    pw = os.environ.get("ADMIN_PASSWORD")
    if not pw:
        pytest.fail("ADMIN_PASSWORD must be set (scripts/e2e.sh pins one)")
    return pw


def _login(client: httpx.Client) -> None:
    assert (
        client.post(
            "/api/auth/login", json={"username": ADMIN_USERNAME, "password": _password()}
        ).status_code
        == 204
    )


def _set_printer_flag(value: bool) -> None:
    """Live-flip `printer_enabled` via an authenticated `PUT /api/settings/
    app` -- no container recreate, no wait-for-health (the whole point of
    the R10 DB-backed flag). `PUT` is a full five-field replace, so the
    current settings are read back first and only `printer_enabled` is
    changed; the interval fields are left exactly as they are."""
    with httpx.Client(base_url=BASE_URL, timeout=30) as c:
        _login(c)
        current = c.get("/api/settings/app")
        assert current.status_code == 200, current.text
        body = current.json()
        body["printer_enabled"] = value
        updated = c.put("/api/settings/app", json=body)
        assert updated.status_code == 200, updated.text
        assert updated.json()["printer_enabled"] is value


def _minimal_gcode_3mf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("Metadata/plate_1.gcode", "; tdmm e2e\nG28\n")
        z.writestr("3D/3dmodel.model", "<model/>")
    return buf.getvalue()


def test_m4_flag_off_then_wizard_and_preflight() -> None:
    token = uuid.uuid4().hex[:8]
    # -- Phase A: flag OFF (default stack) -- app fully functional, printers 503 --
    _set_printer_flag(False)
    with httpx.Client(base_url=BASE_URL, timeout=30) as c:
        _login(c)
        # I2: assert only printer_enabled -- /features also carries
        # watch_dir/watch_enabled (Round 8 T6), which this test doesn't
        # control and shouldn't couple to.
        assert c.get("/api/features").json()["printer_enabled"] is False
        assert c.post("/api/printers", json=CREATE).status_code == 503
        assert c.get("/api/printers").status_code == 503
        assert c.get("/api/print-jobs").status_code == 503
        # app still works with the flag off:
        assert c.post("/api/models", json={"name": f"Flag Off {token}"}).status_code == 201

    # -- Phase B: flag ON -- wizard/settings API + preflight rejections, no hardware --
    _set_printer_flag(True)
    with httpx.Client(base_url=BASE_URL, timeout=60) as c:
        _login(c)
        assert c.get("/api/features").json()["printer_enabled"] is True

        created = c.post("/api/printers", json=CREATE)
        assert created.status_code == 201, created.text
        pid = created.json()["id"]
        got = c.get(f"/api/printers/{pid}").json()
        assert got["access_code_set"] is True and "access_code" not in got

        # patch name keeps the stored code (still masked)
        assert c.patch(f"/api/printers/{pid}", json={"name": "renamed"}).json()["name"] == "renamed"

        # test-connection probes end-to-end and soft-fails (bogus host, no printer)
        probe = c.post(f"/api/printers/{pid}/test", timeout=30).json()
        assert probe["ok"] is False and probe["detail"]

        # preflight: create a model + revision, upload a bare STL -> 422 (not sliced)
        model = c.post("/api/models", json={"name": f"Send Model {token}"}).json()
        rev = model["current_revision"]
        stl = c.put(
            "/api/uploads",
            params={"model_id": model["id"], "revision_id": rev["id"], "rel_path": "part.stl"},
            content=b"solid x\nendsolid x\n",
        )
        assert stl.status_code == 201
        r422 = c.post(f"/api/printers/{pid}/print", json={"file_id": stl.json()["file_id"]})
        assert r422.status_code == 422

        # upload a real .gcode.3mf -> 409 (printerd not running -> status unknown, not idle)
        g = c.put(
            "/api/uploads",
            params={"model_id": model["id"], "revision_id": rev["id"], "rel_path": "job.gcode.3mf"},
            content=_minimal_gcode_3mf(),
        )
        assert g.status_code == 201
        r409 = c.post(f"/api/printers/{pid}/print", json={"file_id": g.json()["file_id"]})
        assert r409.status_code == 409

        assert c.delete(f"/api/printers/{pid}").status_code == 204
