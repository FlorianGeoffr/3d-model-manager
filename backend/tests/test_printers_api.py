"""Printers CRUD API (M4 Task 4): encrypt-on-write / mask-on-read access
code, the flag-off 503 gate, and the Developer-Mode test probe. The
decrypted access code must never appear in a response body (Global
Constraints) -- every assertion here that touches the code goes through
``decrypt_secret`` against the DB row directly, never the API response.
"""

from __future__ import annotations

from app.config import get_settings
from app.crypto import decrypt_secret
from app.models import Printer
from app.printers.base import ProbeResult

CREATE = {"name": "A1 mini", "host": "192.168.1.50", "serial": "0309ABC", "access_code": "12345678"}


async def test_503_when_disabled(authenticated_client):
    assert (await authenticated_client.post("/api/printers", json=CREATE)).status_code == 503


async def test_flag_flip_via_settings_app_takes_effect_without_restart(authenticated_client):
    """Round 10 T3: require_printer_enabled reads the DB-backed AppConfig
    live, per request -- flipping printer_enabled via PUT /settings/app
    takes effect on the very next request against the SAME client (no
    process restart, which isn't even a thing a test client could do)."""
    assert (await authenticated_client.get("/api/printers")).status_code == 503

    payload = {
        "printer_enabled": True,
        "scan_interval_s": 0,
        "collection_sync_interval_s": 0,
        "watch_interval_s": 0,
        "watch_stable_s": 10.0,
    }
    put = await authenticated_client.put("/api/settings/app", json=payload)
    assert put.status_code == 200 and put.json()["printer_enabled"] is True

    assert (await authenticated_client.get("/api/printers")).status_code == 200


async def test_create_masks_code(authenticated_client, printer_enabled):
    r = await authenticated_client.post("/api/printers", json=CREATE)
    assert r.status_code == 201
    body = r.json()
    assert body["access_code_set"] is True
    assert "access_code" not in body and "access_code_enc" not in body
    assert body["serial"] == "0309ABC" and body["kind"] == "bambu_lan"


async def test_create_requires_code(authenticated_client, printer_enabled):
    assert (
        await authenticated_client.post("/api/printers", json={**CREATE, "access_code": ""})
    ).status_code == 422


async def test_stored_code_is_ciphertext_and_decryptable(
    authenticated_client, printer_enabled, db_session
):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    printer = await db_session.get(Printer, pid)
    assert printer.access_code_enc != "12345678"
    assert decrypt_secret(get_settings(), printer.access_code_enc) == "12345678"


async def test_patch_blank_keeps_stored_code(authenticated_client, printer_enabled, db_session):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"name": "renamed"})
    assert r.status_code == 200 and r.json()["name"] == "renamed"
    printer = await db_session.get(Printer, pid)
    assert decrypt_secret(get_settings(), printer.access_code_enc) == "12345678"


async def test_patch_sentinel_with_stored_keeps_code(
    authenticated_client, printer_enabled, db_session
):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    assert (
        await authenticated_client.patch(f"/api/printers/{pid}", json={"access_code": "***"})
    ).status_code == 200
    printer = await db_session.get(Printer, pid)
    assert decrypt_secret(get_settings(), printer.access_code_enc) == "12345678"


async def test_patch_new_code_reencrypts(authenticated_client, printer_enabled, db_session):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    await authenticated_client.patch(f"/api/printers/{pid}", json={"access_code": "87654321"})
    printer = await db_session.get(Printer, pid)
    assert decrypt_secret(get_settings(), printer.access_code_enc) == "87654321"


async def test_test_probe_uses_adapter(authenticated_client, printer_enabled, fake_adapter):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    fake_adapter.probe_result = ProbeResult(ok=True, detail="ok", gcode_state="IDLE")
    r = await authenticated_client.post(f"/api/printers/{pid}/test")
    assert r.status_code == 200 and r.json() == {"ok": True, "detail": "ok", "gcode_state": "IDLE"}


async def test_delete_printer(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    assert (await authenticated_client.delete(f"/api/printers/{pid}")).status_code == 204
    assert (await authenticated_client.get(f"/api/printers/{pid}")).status_code == 404


# ---------------------------------------------------------------------------
# Round 8 T1: serial is required + a lenient alnum/6-24-char shape (the
# probe's TLS cert cross-match is the authoritative check, not this schema).
# ---------------------------------------------------------------------------


async def test_create_rejects_blank_serial(authenticated_client, printer_enabled):
    r = await authenticated_client.post("/api/printers", json={**CREATE, "serial": "   "})
    assert r.status_code == 422


async def test_create_rejects_serial_with_dash(authenticated_client, printer_enabled):
    r = await authenticated_client.post("/api/printers", json={**CREATE, "serial": "030-9ABC"})
    assert r.status_code == 422


async def test_create_rejects_serial_too_short(authenticated_client, printer_enabled):
    r = await authenticated_client.post("/api/printers", json={**CREATE, "serial": "ABCDE"})
    assert r.status_code == 422


async def test_create_accepts_24_char_serial(authenticated_client, printer_enabled):
    serial = "A" * 24
    r = await authenticated_client.post("/api/printers", json={**CREATE, "serial": serial})
    assert r.status_code == 201 and r.json()["serial"] == serial


async def test_patch_rejects_explicit_null_serial(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"serial": None})
    assert r.status_code == 422


async def test_patch_rejects_blank_serial(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"serial": "  "})
    assert r.status_code == 422


async def test_patch_omitted_serial_keeps_stored_value(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"name": "renamed"})
    assert r.status_code == 200 and r.json()["serial"] == CREATE["serial"]


async def test_patch_valid_serial_updates(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"serial": "NEWSERIAL01"})
    assert r.status_code == 200 and r.json()["serial"] == "NEWSERIAL01"


# ---------------------------------------------------------------------------
# Round 8 T1: POST /printers/detect-serial -- reads the serial off the
# printer's TLS cert (app.printers.discovery.read_cert_cn), no DB row or
# access code involved.
# ---------------------------------------------------------------------------


async def test_detect_serial_503_when_disabled(authenticated_client):
    r = await authenticated_client.post("/api/printers/detect-serial", json={"host": "10.0.0.5"})
    assert r.status_code == 503


async def test_detect_serial_happy(authenticated_client, printer_enabled, monkeypatch):
    from app.api import printers as printers_api

    monkeypatch.setattr(
        printers_api.discovery, "read_cert_cn", lambda host, port: "0309CA410600958"
    )
    r = await authenticated_client.post("/api/printers/detect-serial", json={"host": "10.0.0.5"})
    assert r.status_code == 200
    assert r.json() == {
        "serial": "0309CA410600958",
        "detail": "Detected serial from the printer's certificate.",
    }


async def test_detect_serial_empty_cn(authenticated_client, printer_enabled, monkeypatch):
    from app.api import printers as printers_api

    monkeypatch.setattr(printers_api.discovery, "read_cert_cn", lambda host, port: "")
    r = await authenticated_client.post("/api/printers/detect-serial", json={"host": "10.0.0.5"})
    assert r.status_code == 200
    body = r.json()
    assert body["serial"] is None and "no serial" in body["detail"]


async def test_detect_serial_error(authenticated_client, printer_enabled, monkeypatch):
    from app.api import printers as printers_api

    def _boom(host, port):
        raise OSError("nope")

    monkeypatch.setattr(printers_api.discovery, "read_cert_cn", _boom)
    r = await authenticated_client.post("/api/printers/detect-serial", json={"host": "10.0.0.5"})
    assert r.status_code == 200
    body = r.json()
    assert body["serial"] is None and "Couldn't read a serial" in body["detail"]


# ---------------------------------------------------------------------------
# R13c: build_volume_mm seeding
# ---------------------------------------------------------------------------


async def test_create_seeds_build_volume_from_a1_mini_model(authenticated_client, printer_enabled):
    r = await authenticated_client.post(
        "/api/printers", json={**CREATE, "model": "Bambu Lab A1 mini"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["build_volume_mm"] == {"x": 180.0, "y": 180.0, "z": 180.0}


async def test_create_seeds_build_volume_from_plain_a1_model_not_mini(
    authenticated_client, printer_enabled
):
    r = await authenticated_client.post("/api/printers", json={**CREATE, "model": "Bambu Lab A1"})
    assert r.status_code == 201, r.text
    assert r.json()["build_volume_mm"] == {"x": 256.0, "y": 256.0, "z": 256.0}


async def test_create_seeds_build_volume_for_prusa_mk4(authenticated_client, printer_enabled):
    r = await authenticated_client.post("/api/printers", json={**CREATE, "model": "Prusa MK4"})
    assert r.status_code == 201, r.text
    assert r.json()["build_volume_mm"] == {"x": 250.0, "y": 210.0, "z": 220.0}


async def test_create_unknown_model_leaves_build_volume_null(authenticated_client, printer_enabled):
    r = await authenticated_client.post(
        "/api/printers", json={**CREATE, "model": "Some Unknown Thing"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["build_volume_mm"] is None


async def test_create_explicit_build_volume_wins_over_model_seed(
    authenticated_client, printer_enabled
):
    r = await authenticated_client.post(
        "/api/printers",
        json={**CREATE, "model": "Bambu Lab A1 mini", "build_volume_mm": {"x": 1, "y": 2, "z": 3}},
    )
    assert r.status_code == 201, r.text
    assert r.json()["build_volume_mm"] == {"x": 1.0, "y": 2.0, "z": 3.0}


async def test_patch_updates_build_volume(authenticated_client, printer_enabled):
    pid = (await authenticated_client.post("/api/printers", json=CREATE)).json()["id"]
    got = await authenticated_client.get(f"/api/printers/{pid}")
    assert got.json()["build_volume_mm"] is None

    r = await authenticated_client.patch(
        f"/api/printers/{pid}", json={"build_volume_mm": {"x": 300, "y": 300, "z": 400}}
    )
    assert r.status_code == 200, r.text
    assert r.json()["build_volume_mm"] == {"x": 300.0, "y": 300.0, "z": 400.0}


async def test_patch_model_change_reseeds_null_build_volume(authenticated_client, printer_enabled):
    """A `model` PATCH re-runs the create-time seed when build_volume_mm is
    still NULL and the patch itself didn't set one -- otherwise a printer
    created before its model was known (or with an unrecognized model) stays
    stuck at null forever even after the model is corrected."""
    pid = (
        await authenticated_client.post("/api/printers", json={**CREATE, "model": "Unknown"})
    ).json()["id"]
    assert (await authenticated_client.get(f"/api/printers/{pid}")).json()[
        "build_volume_mm"
    ] is None

    r = await authenticated_client.patch(
        f"/api/printers/{pid}", json={"model": "Bambu Lab A1 mini"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["build_volume_mm"] == {"x": 180.0, "y": 180.0, "z": 180.0}


async def test_patch_model_change_does_not_override_explicit_build_volume(
    authenticated_client, printer_enabled
):
    pid = (
        await authenticated_client.post("/api/printers", json={**CREATE, "model": "Unknown"})
    ).json()["id"]

    r = await authenticated_client.patch(
        f"/api/printers/{pid}",
        json={"model": "Bambu Lab A1 mini", "build_volume_mm": {"x": 1, "y": 2, "z": 3}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["build_volume_mm"] == {"x": 1.0, "y": 2.0, "z": 3.0}


async def test_patch_model_change_does_not_override_existing_build_volume(
    authenticated_client, printer_enabled
):
    """A printer that already has a (possibly hand-edited) build_volume_mm
    keeps it on an unrelated model rename -- the re-seed only fires when the
    column is NULL."""
    pid = (
        await authenticated_client.post(
            "/api/printers", json={**CREATE, "model": "Bambu Lab A1 mini"}
        )
    ).json()["id"]
    await authenticated_client.patch(
        f"/api/printers/{pid}", json={"build_volume_mm": {"x": 9, "y": 9, "z": 9}}
    )

    r = await authenticated_client.patch(f"/api/printers/{pid}", json={"model": "Prusa MK4"})
    assert r.status_code == 200, r.text
    assert r.json()["build_volume_mm"] == {"x": 9.0, "y": 9.0, "z": 9.0}
