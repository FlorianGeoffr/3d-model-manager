"""M4 printer e2e (Task 9): drives the flag-OFF safety path, then flips the
flag and drives the wizard/settings API + the send-flow preflight
rejections -- ALL without any printer hardware (the physical print start is
the deferred Manual/Live Acceptance below). Mirrors test_m3_scan.py's e2e
conventions; uses `docker compose up -d --force-recreate api` to toggle the
flag, the same class of container-side idiom test_m1_flow.py uses."""

from __future__ import annotations

import io
import os
import subprocess
import time
import uuid
import zipfile
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.e2e

REPO_ROOT = Path(__file__).resolve().parents[2]
BASE_URL = os.environ.get("TDMM_E2E_BASE_URL", "http://localhost:8080")
HEALTH_URL = f"{BASE_URL}/api/health"
ADMIN_USERNAME = os.environ.get("TDMM_ADMIN_USERNAME", "admin")

CREATE = {
    "name": "E2E A1",
    "host": "10.255.255.1",
    "serial": "E2ESERIAL",
    "access_code": "12345678",
}


def _password() -> str:
    pw = os.environ.get("TDMM_ADMIN_PASSWORD")
    if not pw:
        pytest.fail("TDMM_ADMIN_PASSWORD must be set (scripts/e2e.sh pins one)")
    return pw


def _login(client: httpx.Client) -> None:
    assert (
        client.post(
            "/api/auth/login", json={"username": ADMIN_USERNAME, "password": _password()}
        ).status_code
        == 204
    )


def _wait_health(timeout: float = 120.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if httpx.get(HEALTH_URL, timeout=3).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(2)
    pytest.fail("api did not become healthy after recreate")


def _set_printer_flag(value: bool) -> None:
    env = REPO_ROOT / ".env"
    lines = [
        ln for ln in env.read_text().splitlines() if not ln.startswith("TDMM_PRINTER_ENABLED=")
    ]
    lines.append(f"TDMM_PRINTER_ENABLED={'true' if value else 'false'}")
    env.write_text("\n".join(lines) + "\n")
    subprocess.run(
        ["docker", "compose", "up", "-d", "--force-recreate", "--no-deps", "api"],
        check=True,
        cwd=REPO_ROOT,
        timeout=180,
    )
    _wait_health()


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
        assert c.get("/api/features").json() == {"printer_enabled": False}
        assert c.post("/api/printers", json=CREATE).status_code == 503
        assert c.get("/api/printers").status_code == 503
        assert c.get("/api/print-jobs").status_code == 503
        # app still works with the flag off:
        assert c.post("/api/models", json={"name": f"Flag Off {token}"}).status_code == 201

    # -- Phase B: flag ON -- wizard/settings API + preflight rejections, no hardware --
    _set_printer_flag(True)
    with httpx.Client(base_url=BASE_URL, timeout=60) as c:
        _login(c)
        assert c.get("/api/features").json() == {"printer_enabled": True}

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
