"""Schemas for the printers CRUD + probe/status/print API (SPEC "API
surface"; M4). ``PrinterOut`` NEVER carries ``access_code``/
``access_code_enc`` -- only ``access_code_set: bool`` (Global Constraints:
the decrypted access code must never appear in an API response). Encryption
happens in ``app.api.printers`` via ``app.crypto.encrypt_secret``; decryption
happens ONLY inside the test-probe path via
``app.printers.connection.connection_from_printer``.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.models.enums import PrinterKind

if TYPE_CHECKING:
    from app.models import Printer, PrintJob


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.BAMBU_LAN
    host: str
    serial: str
    access_code: str
    model: str | None = None
    enabled: bool = True
    options: dict = Field(default_factory=dict)


class PrinterUpdate(BaseModel):
    name: str | None = None
    host: str | None = None
    serial: str | None = None
    access_code: str | None = None
    model: str | None = None
    enabled: bool | None = None
    options: dict | None = None


class PrinterOut(BaseModel):
    id: int
    name: str
    kind: str
    host: str
    serial: str
    model: str | None
    enabled: bool
    options: dict
    access_code_set: bool  # NEVER the code or ciphertext

    @classmethod
    def from_model(cls, p: Printer) -> PrinterOut:
        return cls(
            id=p.id,
            name=p.name,
            kind=p.kind,
            host=p.host,
            serial=p.serial,
            model=p.model,
            enabled=p.enabled,
            options=p.options or {},
            access_code_set=bool(p.access_code_enc),
        )


class ProbeOut(BaseModel):
    ok: bool
    detail: str
    gcode_state: str | None = None


class PrinterStatusOut(BaseModel):
    online: bool
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


class PrintRequest(BaseModel):
    file_id: int
    plate: int = 1
    subtask_name: str | None = None
    use_ams: bool = False
    ams_mapping: list[int] = Field(default_factory=lambda: [0])
    bed_levelling: bool = True
    flow_cali: bool = True
    timelapse: bool = False


class PrintJobOut(BaseModel):
    id: int
    printer_id: int
    file_id: int
    subtask_name: str | None
    state: str
    progress_pct: float | None
    remaining_min: int | None
    layer: int | None
    total_layers: int | None
    printer_error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def from_model(cls, j: PrintJob) -> PrintJobOut:
        return cls(
            id=j.id,
            printer_id=j.printer_id,
            file_id=j.file_id,
            subtask_name=j.subtask_name,
            state=j.state,
            progress_pct=j.progress_pct,
            remaining_min=j.remaining_min,
            layer=j.layer,
            total_layers=j.total_layers,
            printer_error=j.printer_error,
            created_at=j.created_at,
            started_at=j.started_at,
            finished_at=j.finished_at,
        )
