from __future__ import annotations

from unittest.mock import patch


CREATE_MOONRAKER = {
    "name": "Qidi Q2",
    "kind": "moonraker",
    "host": "imprimante3d-1.lan",
    "serial": "Q20001",
}


async def _make_moonraker_printer(client) -> int:
    return (await client.post("/api/printers", json=CREATE_MOONRAKER)).json()["id"]


async def test_camera_returns_stream_info(authenticated_client, printer_enabled):
    pid = await _make_moonraker_printer(authenticated_client)
    with patch(
        "app.printers.moonraker.MoonrakerAdapter.get_camera_urls",
        return_value={
            "name": "Qidi Cam",
            "stream_url": "http://imprimante3d-1.lan/webcam/?action=stream",
            "snapshot_url": "http://imprimante3d-1.lan/webcam/?action=snapshot",
            "aspect_ratio": "4:3",
        },
    ):
        r = await authenticated_client.get(f"/api/printers/{pid}/camera")
        assert r.status_code == 200
        data = r.json()
        assert data["available"] is True
        assert data["name"] == "Qidi Cam"
        assert data["stream_url"] == f"/api/printers/{pid}/camera/stream"
        assert data["snapshot_url"] == f"/api/printers/{pid}/camera/snapshot"
        assert data["direct_stream_url"] == "http://imprimante3d-1.lan/webcam/?action=stream"


async def test_camera_unavailable_when_no_stream(authenticated_client, printer_enabled):
    pid = await _make_moonraker_printer(authenticated_client)
    with patch(
        "app.printers.moonraker.MoonrakerAdapter.get_camera_urls",
        return_value={},
    ):
        r = await authenticated_client.get(f"/api/printers/{pid}/camera")
        assert r.status_code == 200
        data = r.json()
        assert data["available"] is False
