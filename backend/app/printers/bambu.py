"""bambu_lan PrinterAdapter over the bambulabs_api Printer client (SPEC
"Printer integration": "Lib: bambulabs-api behind the adapter"). The lib
owns the MQTT session, FTPS upload, pushall, and the incremental status
merge; this adapter only NORMALIZES the lib's typed accessors into our
PrinterPublicState and forwards upload/start/commands. bambulabs_api is
lazy-imported inside _build_printer, so importing this module (and thus the
registry + the printers API router) is safe with the printer flag OFF."""

from __future__ import annotations

import time
from typing import ClassVar

from app.models.enums import PrinterKind, PrintJobState
from app.printers.base import (
    PrinterAdapter,
    PrinterConnection,
    PrinterPublicState,
    PrintSpec,
    ProbeResult,
    ReportHandler,
)
from app.printers.registry import register_adapter

_GCODE_STATE_TO_JOB = {
    "PREPARE": PrintJobState.STARTING,
    "RUNNING": PrintJobState.PRINTING,
    "PAUSE": PrintJobState.PAUSED,
    "FINISH": PrintJobState.FINISHED,
    "FAILED": PrintJobState.FAILED,
}


def _build_printer(conn: PrinterConnection):
    """Construct the bambulabs_api client (lazy import -- flag-off safety).
    Positional arg order is (ip, access_code, serial), verified against
    v2.6.6. Tests monkeypatch this to inject a stub."""
    import bambulabs_api as bl

    return bl.Printer(conn.host, conn.access_code, conn.serial)


def _state_token(state) -> str | None:
    """Normalize the lib's get_state() (a GcodeState enum or a str) to an
    UPPER-CASE token like 'RUNNING'/'IDLE'/'FINISH'. Confirmed against the
    installed v2.6.6 wheel: GcodeState members are
    IDLE/PREPARE/RUNNING/PAUSE/FINISH/FAILED/UNKNOWN, name == value (already
    upper-case), so this also just passes through a plain str unchanged."""
    raw = getattr(state, "value", None) or getattr(state, "name", None) or state
    text = str(raw or "").rsplit(".", 1)[-1].upper()
    return text or None


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _dump_get(dump: dict, key: str):
    """Best-effort lookup of a field in the lib's mqtt_dump(). The real
    v2.6.6 Printer.mqtt_dump() returns the RAW top-level MQTT payload
    (``{"print": {...}, "info": {...}}``) -- fields like "print_error" and
    "wifi_signal" live nested under ``dump["print"][key]`` (confirmed by
    reading PrinterMQTTClient.__get_print in the installed wheel, which is
    exactly how the lib's own print_error_code()/wifi_signal() helpers read
    them). Edge-stub tests exercise a flatter shape (``{"print_error": 0,
    ...}``) directly at the top level, so this checks top-level first, then
    falls back to the nested "print" dict, and degrades to None -- never
    raises -- if neither is present."""
    if key in dump:
        return dump[key]
    nested = dump.get("print")
    if isinstance(nested, dict):
        return nested.get(key)
    return None


@register_adapter
class BambuLanAdapter(PrinterAdapter):
    kind: ClassVar[PrinterKind] = PrinterKind.BAMBU_LAN

    def __init__(self, conn: PrinterConnection) -> None:
        super().__init__(conn)
        self._printer = None
        self._handler: ReportHandler | None = None

    def _client(self):
        if self._printer is None:
            self._printer = _build_printer(self.conn)
        return self._printer

    # -- normalization (the logic WE own; unit-tested) -----------------
    def _snapshot(self) -> dict:
        """Read the lib's current (already-merged) state into our normalized
        snapshot dict. Cheap LOCAL reads -- the lib's MQTT thread keeps its
        state fresh, so there is no printer round-trip per call."""
        p = self._client()
        try:
            dump = p.mqtt_dump() or {}
        except Exception:  # noqa: BLE001 -- mqtt_dump is best-effort for the two extras
            dump = {}
        return {
            "gcode_state": _state_token(p.get_state()),
            "mc_percent": _as_int(p.get_percentage()),
            "layer_num": _as_int(p.current_layer_num()),
            "total_layer_num": _as_int(p.total_layer_num()),
            "mc_remaining_time": _as_int(p.get_time()),
            "print_error": _as_int(_dump_get(dump, "print_error")),
            "nozzle_temper": p.get_nozzle_temperature(),
            "bed_temper": p.get_bed_temperature(),
            "subtask_name": p.subtask_name() or p.get_file_name() or None,
            "wifi_signal": _dump_get(dump, "wifi_signal"),
        }

    def merge_report(self, prev: dict | None, report: dict) -> dict:
        # The lib delivers a FULL merged snapshot (not a diff), so the latest
        # snapshot IS the merged state -- keep the ABC contract, ignore prev.
        return dict(report)

    def public_state(self, merged: dict) -> PrinterPublicState:
        return PrinterPublicState(
            gcode_state=merged.get("gcode_state"),
            mc_percent=merged.get("mc_percent"),
            layer_num=merged.get("layer_num"),
            total_layer_num=merged.get("total_layer_num"),
            mc_remaining_time=merged.get("mc_remaining_time"),
            print_error=merged.get("print_error"),
            nozzle_temper=merged.get("nozzle_temper"),
            bed_temper=merged.get("bed_temper"),
            subtask_name=merged.get("subtask_name"),
            wifi_signal=merged.get("wifi_signal"),
        )

    def job_state(self, public: PrinterPublicState) -> PrintJobState | None:
        if public.print_error:
            return PrintJobState.FAILED
        return _GCODE_STATE_TO_JOB.get(public.gcode_state or "")

    # -- lifecycle -----------------------------------------------------
    def connect(self) -> None:
        self._client().connect()

    def close(self) -> None:
        if self._printer is not None:
            try:
                self._printer.disconnect()
            finally:
                self._printer = None

    def set_report_handler(self, handler: ReportHandler) -> None:
        self._handler = handler

    def request_full_status(self) -> None:
        # For the lib-backed adapter this is a cheap LOCAL read of the lib's
        # merged state, emitted to printerd's handler (no printer traffic --
        # the lib already ran pushall on connect and keeps state current).
        if self._handler is not None:
            self._handler(self._snapshot())

    # -- commands ------------------------------------------------------
    def pause(self) -> None:
        self._client().pause_print()

    def resume(self) -> None:
        self._client().resume_print()

    def stop(self) -> None:
        self._client().stop_print()

    # -- send ----------------------------------------------------------
    def upload_and_start(self, spec: PrintSpec) -> None:
        p = self._client()
        with spec.source_path.open("rb") as fh:
            p.upload_file(fh, spec.remote_name)  # -> /cache/<remote_name> on the SD
        # The lib builds the exact project_file payload + url internally; we
        # forward only what its start_print accepts (no bed_levelling/timelapse).
        p.start_print(
            spec.remote_name,
            spec.plate,
            use_ams=spec.use_ams,
            ams_mapping=list(spec.ams_mapping),
            flow_calibration=spec.flow_cali,
        )

    # -- probe ---------------------------------------------------------
    def test_connection(self, *, timeout: float = 10.0) -> ProbeResult:
        state = None
        try:
            p = self._client()
            p.connect()
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                state = _state_token(p.get_state())
                if state:
                    break
                time.sleep(0.5)
        except Exception as exc:  # noqa: BLE001 -- a probe never raises to the caller
            return ProbeResult(ok=False, detail=f"{type(exc).__name__}: {exc}")
        finally:
            self.close()
        if state:
            return ProbeResult(
                ok=True, detail="connected; Developer Mode responding", gcode_state=state
            )
        return ProbeResult(
            ok=False, detail="connected but no state (is LAN-only + Developer Mode on?)"
        )
