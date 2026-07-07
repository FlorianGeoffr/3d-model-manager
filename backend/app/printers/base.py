"""The ``PrinterAdapter`` contract (SPEC "Printer integration"): every
capability printerd and the API need, kind-agnostic. ``printerd`` and the API
only ever speak this ABC -- never a concrete adapter (M4 plan Task 2).

Import-safety: this module must be importable with the printer feature OFF,
so it pulls in stdlib + ``app.models.enums`` only -- no ``bambulabs_api``, no
``paho``. The real ``bambu_lan`` adapter (Task 3) lazy-imports those inside
its own build function.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import ClassVar

from app.models.enums import PrinterKind, PrintJobState

ReportHandler = Callable[[dict], None]


@dataclass(frozen=True)
class PrinterConnection:
    """Everything an adapter needs to reach ONE printer. ``access_code`` is
    the DECRYPTED code -- this object is only ever built inside the adapter/
    printerd/probe processes (never in a CRUD read path)."""

    host: str
    serial: str
    access_code: str
    model: str | None = None
    options: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PrintSpec:
    """One plate of one ``.gcode.3mf`` to upload + start."""

    source_path: Path  # local temp .gcode.3mf to FTPS-upload
    remote_name: str  # filename under /cache/ on the SD card
    plate: int  # N -> param "Metadata/plate_N.gcode"
    subtask_name: str
    use_ams: bool = False
    ams_mapping: tuple[int, ...] = (0,)
    bed_levelling: bool = True
    flow_cali: bool = True
    timelapse: bool = False


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    detail: str
    gcode_state: str | None = None


@dataclass
class PrinterPublicState:
    """The ONLY printer telemetry that leaves printerd (Redis + status
    endpoint). Never carries the access code."""

    gcode_state: str | None = None
    mc_percent: int | None = None
    layer_num: int | None = None
    total_layer_num: int | None = None
    mc_remaining_time: int | None = None
    print_error: int | None = None
    nozzle_temper: float | None = None
    bed_temper: float | None = None
    subtask_name: str | None = None
    wifi_signal: str | None = None


def state_key(printer_id: int) -> str:
    return f"printer:{printer_id}:state"


def command_channel(printer_id: int) -> str:
    return f"printer:{printer_id}:commands"


class PrinterAdapter(ABC):
    kind: ClassVar[PrinterKind]

    def __init__(self, conn: PrinterConnection) -> None:
        self.conn = conn

    @abstractmethod
    def test_connection(self, *, timeout: float = 10.0) -> ProbeResult: ...
    @abstractmethod
    def connect(self) -> None: ...
    @abstractmethod
    def close(self) -> None: ...
    @abstractmethod
    def set_report_handler(self, handler: ReportHandler) -> None: ...
    @abstractmethod
    def request_full_status(self) -> None: ...  # MQTT pushall
    @abstractmethod
    def upload_and_start(self, spec: PrintSpec) -> None: ...
    @abstractmethod
    def pause(self) -> None: ...
    @abstractmethod
    def resume(self) -> None: ...
    @abstractmethod
    def stop(self) -> None: ...
    @abstractmethod
    def merge_report(self, prev: dict | None, report: dict) -> dict: ...
    @abstractmethod
    def public_state(self, merged: dict) -> PrinterPublicState: ...
    @abstractmethod
    def job_state(self, public: PrinterPublicState) -> PrintJobState | None: ...
