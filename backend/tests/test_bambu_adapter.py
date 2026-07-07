import time

from app.models.enums import PrintJobState
from app.printers import bambu
from app.printers.bambu import BambuLanAdapter
from app.printers.base import PrinterConnection, PrinterPublicState, PrintSpec
from tests.cassettes import bambu_snapshots as snap

CONN = PrinterConnection(host="1.2.3.4", serial="0309ABC", access_code="12345678")


class StubPrinter:
    """Edge stub for a bambulabs_api.Printer -- records calls, canned status."""

    def __init__(self) -> None:
        self.connected = self.disconnected = False
        self.paused = self.resumed = self.stopped = 0
        self.uploaded: list[str] = []
        self.started: list[tuple] = []

    def mqtt_start(self):
        self.connected = True

    def disconnect(self):
        self.disconnected = True

    def get_state(self):
        return "RUNNING"

    def get_percentage(self):
        return 55

    def current_layer_num(self):
        return 66

    def total_layer_num(self):
        return 120

    def get_time(self):
        return 21

    def get_nozzle_temperature(self):
        return 220.0

    def get_bed_temperature(self):
        return 60.0

    def subtask_name(self):
        return "widget"

    def get_file_name(self):
        return "widget.gcode.3mf"

    def mqtt_dump(self):
        return {"print_error": 0, "wifi_signal": "-45dBm"}

    def upload_file(self, file, filename):
        self.uploaded.append(filename)
        return f"/cache/{filename}"

    def start_print(
        self,
        filename,
        plate_number,
        use_ams=True,
        ams_mapping=(0,),
        skip_objects=None,
        flow_calibration=True,
    ):
        self.started.append((filename, plate_number, use_ams, tuple(ams_mapping), flow_calibration))
        return True

    def pause_print(self):
        self.paused += 1
        return True

    def resume_print(self):
        self.resumed += 1
        return True

    def stop_print(self):
        self.stopped += 1
        return True


def _stub_adapter(monkeypatch) -> tuple[BambuLanAdapter, StubPrinter]:
    stub = StubPrinter()
    monkeypatch.setattr(bambu, "_build_printer", lambda conn: stub)
    return BambuLanAdapter(CONN), stub


def test_public_state_extracts_from_snapshot():
    ps = BambuLanAdapter(CONN).public_state(snap.SNAPSHOT_PRINTING)
    assert ps.gcode_state == "RUNNING" and ps.mc_percent == 55
    assert ps.layer_num == 66 and ps.total_layer_num == 120
    assert ps.nozzle_temper == 220.0 and ps.bed_temper == 60.0


def test_job_state_mapping():
    a = BambuLanAdapter(CONN)
    assert a.job_state(PrinterPublicState(gcode_state="RUNNING")) == PrintJobState.PRINTING
    assert a.job_state(PrinterPublicState(gcode_state="PAUSE")) == PrintJobState.PAUSED
    assert a.job_state(PrinterPublicState(gcode_state="FINISH")) == PrintJobState.FINISHED
    assert a.job_state(PrinterPublicState(gcode_state="IDLE")) is None
    assert (
        a.job_state(PrinterPublicState(gcode_state="RUNNING", print_error=83935248))
        == PrintJobState.FAILED
    )


def test_snapshot_normalizes_lib_accessors(monkeypatch):
    a, _stub = _stub_adapter(monkeypatch)
    s = a._snapshot()
    assert s["gcode_state"] == "RUNNING" and s["mc_percent"] == 55
    assert s["layer_num"] == 66 and s["total_layer_num"] == 120 and s["mc_remaining_time"] == 21
    assert s["nozzle_temper"] == 220.0 and s["bed_temper"] == 60.0
    assert s["subtask_name"] == "widget" and s["print_error"] == 0 and s["wifi_signal"] == "-45dBm"


def test_request_full_status_emits_snapshot(monkeypatch):
    a, _stub = _stub_adapter(monkeypatch)
    seen: list[dict] = []
    a.set_report_handler(seen.append)
    a.request_full_status()
    assert seen and a.public_state(seen[0]).gcode_state == "RUNNING"


def test_upload_and_start_calls_lib_with_right_args(monkeypatch, tmp_path):
    a, stub = _stub_adapter(monkeypatch)
    src = tmp_path / "job.gcode.3mf"
    src.write_bytes(b"zip")
    a.upload_and_start(
        PrintSpec(
            source_path=src,
            remote_name="tdmm-7.gcode.3mf",
            plate=2,
            subtask_name="w",
            use_ams=True,
            ams_mapping=(1,),
        )
    )
    assert stub.uploaded == ["tdmm-7.gcode.3mf"]
    assert stub.started == [("tdmm-7.gcode.3mf", 2, True, (1,), True)]


def test_commands_call_lib(monkeypatch):
    a, stub = _stub_adapter(monkeypatch)
    a.pause()
    a.resume()
    a.stop()
    assert stub.paused == 1 and stub.resumed == 1 and stub.stopped == 1


def test_test_connection_ok(monkeypatch):
    a, stub = _stub_adapter(monkeypatch)
    result = a.test_connection(timeout=2)
    assert result.ok is True and result.gcode_state == "RUNNING"
    assert stub.connected and stub.disconnected


def test_test_connection_soft_fails(monkeypatch):
    class _Boom:
        def mqtt_start(self):
            raise OSError("no route to host")

        def disconnect(self):
            pass

    monkeypatch.setattr(bambu, "_build_printer", lambda conn: _Boom())
    result = BambuLanAdapter(CONN).test_connection(timeout=1)
    assert result.ok is False and "OSError" in result.detail


def test_test_connection_bounded_against_unreachable_host():
    """Regression for the M4 live-e2e hang (task-9-report.md): bl.Printer's
    disconnect() (called from test_connection()'s ``finally: self.close()``)
    used to route through PrinterCamera.stop(), an UNBOUNDED Thread.join() on
    a camera thread blocked inside a timeout-less
    ``socket.create_connection((host, 6000))``. Against an unreachable host
    that blocks for the OS TCP retry ceiling -- measured 136.27s in the
    report, 141.29s reproduced here against the real adapter before the fix
    -- not the adapter's advertised ``timeout``.

    This drives the REAL adapter (NOT StubPrinter -- a same-thread, zero-cost
    stub that never touches a real socket/thread and is exactly why the unit
    suite missed this) against ``192.0.2.1`` (RFC 5737 TEST-NET-1,
    guaranteed non-routable/reserved for documentation) so the socket
    genuinely cannot connect, with no real printer or MQTT broker involved.

    The fix makes connect()/test_connection() call bl.Printer.mqtt_start()
    directly instead of connect() (== mqtt_start() + camera_start()), so the
    camera worker thread is never started and PrinterCamera.stop() is a
    no-op; close() then only waits on paho-mqtt's own loop_stop(), which is
    bounded by its default 5s socket-connect timeout (polled every <=1s).
    """
    conn = PrinterConnection(host="192.0.2.1", serial="E2ESERIAL", access_code="12345678")
    adapter = BambuLanAdapter(conn)
    t0 = time.monotonic()
    result = adapter.test_connection(timeout=1.0)
    elapsed = time.monotonic() - t0
    assert result.ok is False
    assert elapsed < 15, f"probe took {elapsed:.1f}s -- should be bounded, not ~136s"
