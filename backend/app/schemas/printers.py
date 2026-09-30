"""Schemas for the printers CRUD + probe/status/print API (SPEC "API
surface"; M4). ``PrinterOut`` NEVER carries ``access_code``/
``access_code_enc`` -- only ``access_code_set: bool`` (Global Constraints:
the decrypted access code must never appear in an API response). Encryption
happens in ``app.api.printers`` via ``app.crypto.encrypt_secret``; decryption
happens ONLY inside the test-probe path via
``app.printers.connection.connection_from_printer``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Self

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.enums import PrinterKind

if TYPE_CHECKING:
    from app.models import BlobMeta, File, Model, Printer, PrintJob


def _clean_serial(value: str) -> str:
    """Shared body for both schemas' validators (Round 8 T1): strip, reject
    blank, and enforce a LENIENT alnum/6-24-char shape. Deliberately not the
    A1's specific 15-char format -- the ``/printers/{id}/test`` probe's TLS
    cert cross-match (``app.printers.probe``) is the authoritative check;
    this only keeps obviously-wrong input (blank, punctuation, a pasted URL)
    out of the DB.
    """
    stripped = value.strip()
    if not stripped:
        raise ValueError("serial is required")
    if not stripped.isalnum() or not (6 <= len(stripped) <= 24):
        raise ValueError("serial must be 6-24 alphanumeric characters")
    return stripped


class BuildVolumeMm(BaseModel):
    """`{x, y, z}` mm build plate dimensions (R13c) -- used by
    `GcodePreview`'s build-plate render."""

    x: float
    y: float
    z: float


# R13c: seeded onto `Printer.build_volume_mm` on create when `model` matches
# a known key (case-insensitive substring match -- see
# `seed_build_volume_mm`); left `None` for anything else, editable
# afterward. Bambu's A1/A1 mini share a printer `kind` but differ in bed
# size, hence the separate "a1 mini" vs "a1" entries (mini matched first).
_KNOWN_BUILD_VOLUMES_MM: dict[str, BuildVolumeMm] = {
    "a1 mini": BuildVolumeMm(x=180, y=180, z=180),
    "a1": BuildVolumeMm(x=256, y=256, z=256),
    "p1s": BuildVolumeMm(x=256, y=256, z=256),
    "x1c": BuildVolumeMm(x=256, y=256, z=256),
    "mk4": BuildVolumeMm(x=250, y=210, z=220),
    "qidi q2": BuildVolumeMm(x=270, y=270, z=256),
    "q2": BuildVolumeMm(x=270, y=270, z=256),
    "qidi q1 pro": BuildVolumeMm(x=245, y=245, z=245),
    "q1 pro": BuildVolumeMm(x=245, y=245, z=245),
    "qidi x-max 3": BuildVolumeMm(x=325, y=325, z=315),
    "qidi x-plus 3": BuildVolumeMm(x=280, y=280, z=270),
}


def seed_build_volume_mm(model: str | None) -> dict[str, float] | None:
    """Best-effort seed for a new printer's ``build_volume_mm`` from its
    free-text ``model`` field (Round 8 T1: ``Printer`` has no structured
    model enum). Matches the longest/most specific key first (``"a1 mini"``
    before ``"a1"``) so an A1 mini printer doesn't get the plain A1's
    larger bed. Returns ``None`` -- left for the user to fill in -- when
    nothing matches.
    """
    if not model:
        return None
    lowered = model.strip().lower()
    for key in sorted(_KNOWN_BUILD_VOLUMES_MM, key=len, reverse=True):
        if key in lowered:
            return _KNOWN_BUILD_VOLUMES_MM[key].model_dump()
    return None


class PrinterCreate(BaseModel):
    name: str
    kind: PrinterKind = PrinterKind.BAMBU_LAN
    host: str
    serial: str = ""
    access_code: str = ""
    model: str | None = None
    enabled: bool = True
    options: dict = Field(default_factory=dict)
    # R13c: explicit value wins over the `model`-based seed (see
    # `app.api.printers.create_printer`).
    build_volume_mm: BuildVolumeMm | None = None

    @model_validator(mode="after")
    def _validate_fields_by_kind(self) -> Self:
        if self.kind == PrinterKind.BAMBU_LAN:
            if not self.serial or not self.serial.strip():
                raise ValueError("serial is required")
            self.serial = _clean_serial(self.serial)
            if not self.access_code or not self.access_code.strip():
                raise ValueError("access_code is required")
        elif self.kind == PrinterKind.MOONRAKER:
            if not self.serial or not self.serial.strip():
                import hashlib

                h = hashlib.md5(self.host.encode()).hexdigest().upper()[:16]
                self.serial = f"MOON{h[:12]}"
            else:
                self.serial = _clean_serial(self.serial)
        return self


class PrinterUpdate(BaseModel):
    name: str | None = None
    host: str | None = None
    serial: str | None = None
    access_code: str | None = None
    model: str | None = None
    enabled: bool | None = None
    options: dict | None = None
    build_volume_mm: BuildVolumeMm | None = None

    @field_validator("serial")
    @classmethod
    def _validate_serial(cls, value: str | None) -> str:
        """An *absent* ``serial`` is fine (``exclude_unset`` drops it before
        it reaches the service layer, same PATCH pattern as
        ``PrintPatchIn._reject_explicit_null``) -- but an explicit ``null``
        or blank string is a real user mistake (clearing a NOT-NULL column),
        so both raise here rather than sailing through as a 500.
        """
        if value is None:
            raise ValueError("serial cannot be null")
        return _clean_serial(value)


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
    build_volume_mm: BuildVolumeMm | None = None

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
            build_volume_mm=p.build_volume_mm,
        )


class ProbeOut(BaseModel):
    ok: bool
    detail: str
    gcode_state: str | None = None


class DetectSerialIn(BaseModel):
    """``POST /printers/detect-serial`` payload (Round 8 T1): reads the
    serial straight off the printer's TLS cert (``app.printers.discovery``)
    so the user doesn't have to hunt for it on the printer's screen. No
    access code -- this is a plain TLS handshake, not an MQTT login."""

    host: str
    port: int = 8883


class DetectSerialOut(BaseModel):
    serial: str | None = None
    detail: str


class AmsTrayOut(BaseModel):
    """One loaded AMS filament slot (M8 G3 color sync). ``color`` is
    ``#RRGGBB`` (alpha already stripped) or None for an empty/unknown slot."""

    slot: int
    color: str | None = None
    material: str | None = None


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
    trays: list[AmsTrayOut] = Field(default_factory=list)
    light_on: bool | None = None


class PrinterCameraOut(BaseModel):
    available: bool
    name: str = "Camera"
    stream_url: str | None = None
    snapshot_url: str | None = None
    aspect_ratio: str | None = "4:3"
    direct_stream_url: str | None = None


class PrinterLightIn(BaseModel):
    on: bool | None = None


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
    file_rel_path: str | None = None
    blob_hash: str | None = None
    model_id: int | None = None
    model_name: str | None = None
    model_slug: str | None = None
    thumbnail_url: str | None = None
    snapshot_url: str | None = None
    print_time_s: int | None = None
    duration_s: int | None = None
    filament_g: float | None = None
    filament_m: float | None = None
    filament_types: list[str] | None = None

    @classmethod
    def from_model(
        cls,
        j: PrintJob,
        file: File | None = None,
        model: Model | None = None,
        meta: BlobMeta | None = None,
    ) -> PrintJobOut:
        duration_s = None
        if j.started_at and j.finished_at:
            duration_s = int((j.finished_at - j.started_at).total_seconds())
        elif j.started_at and j.state in ("printing", "paused", "uploading", "starting"):
            duration_s = int((datetime.now(UTC) - j.started_at).total_seconds())

        raw = j.raw_status or {}
        snapshot_hash = raw.get("snapshot_blob_hash")
        snapshot_url = f"/api/blobs/{snapshot_hash}/thumb?size=256" if snapshot_hash else None

        thumb_url = None
        if file and file.blob_hash:
            thumb_url = f"/api/blobs/{file.blob_hash}/thumb?size=256"
        elif model and model.cover_blob_hash:
            thumb_url = f"/api/blobs/{model.cover_blob_hash}/thumb?size=256"

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
            file_rel_path=file.rel_path if file else None,
            blob_hash=file.blob_hash if file else None,
            model_id=model.id if model else None,
            model_name=model.name if model else None,
            model_slug=model.slug if model else None,
            thumbnail_url=thumb_url,
            snapshot_url=snapshot_url,
            print_time_s=meta.print_time_s if meta else None,
            duration_s=duration_s,
            filament_g=meta.filament_g if meta else None,
            filament_m=meta.filament_m if meta else None,
            filament_types=meta.filament_types if meta else None,
        )
