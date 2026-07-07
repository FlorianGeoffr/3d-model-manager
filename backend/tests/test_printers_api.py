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
