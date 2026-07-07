"""Printers CRUD + Developer-Mode test probe (SPEC "API surface"; M4).
Encrypt-on-write (Fernet, app.crypto) + mask-on-read (M3's redaction UX):
PrinterOut never carries the code/ciphertext, only ``access_code_set``. The
test probe is the ONLY place the API builds an adapter (decrypts, in a
worker thread) -- and it returns only ok/detail/gcode_state.

Import-safety: only ``app.printers.registry``/``app.printers.connection``
(both lib-free) are imported here -- ``bambulabs_api``/``paho`` are only
ever touched lazily, inside the real adapter's own build function, when a
probe actually runs with the flag on (see ``tests/test_flag_off_imports.py``).
"""

from __future__ import annotations

import anyio
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_printer_enabled
from app.config import Settings, get_settings
from app.crypto import encrypt_secret
from app.db import get_db
from app.models import Blob, File, Printer, PrintJob
from app.models.enums import BlobFormat, PrintJobState
from app.printers.connection import connection_from_printer
from app.printers.registry import build_adapter
from app.schemas.printers import (
    PrinterCreate,
    PrinterOut,
    PrinterUpdate,
    PrintJobOut,
    PrintRequest,
    ProbeOut,
)
from app.services.printer_state import preflight_ok, read_state_async
from app.tasks.printing import send_to_printer

router = APIRouter(
    prefix="/printers", tags=["printers"], dependencies=[Depends(require_printer_enabled)]
)

# Redaction sentinel GET emits for a set secret (mirrors
# app.api.settings._REDACTED_SENTINEL) -- an incoming request carrying this
# literal value is read back verbatim from a form the client seeded off a
# masked PrinterOut, never a real access code.
_REDACTED_SENTINEL = "***"


async def _get_or_404(db: AsyncSession, printer_id: int) -> Printer:
    printer = await db.get(Printer, printer_id)
    if printer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "printer not found")
    return printer


@router.post("", status_code=status.HTTP_201_CREATED, response_model=PrinterOut)
async def create_printer(
    payload: PrinterCreate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PrinterOut:
    code = (payload.access_code or "").strip()
    if code in ("", _REDACTED_SENTINEL):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "access_code is required")
    printer = Printer(
        name=payload.name,
        kind=payload.kind,
        host=payload.host,
        serial=payload.serial,
        access_code_enc=encrypt_secret(settings, code),
        model=payload.model,
        enabled=payload.enabled,
        options=payload.options,
    )
    db.add(printer)
    await db.commit()
    await db.refresh(printer)
    return PrinterOut.from_model(printer)


@router.get("", response_model=list[PrinterOut])
async def list_printers(db: AsyncSession = Depends(get_db)) -> list[PrinterOut]:
    rows = (await db.execute(select(Printer).order_by(Printer.id))).scalars()
    return [PrinterOut.from_model(p) for p in rows]


@router.get("/{printer_id}", response_model=PrinterOut)
async def get_printer(printer_id: int, db: AsyncSession = Depends(get_db)) -> PrinterOut:
    return PrinterOut.from_model(await _get_or_404(db, printer_id))


@router.patch("/{printer_id}", response_model=PrinterOut)
async def update_printer(
    printer_id: int,
    payload: PrinterUpdate,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PrinterOut:
    printer = await _get_or_404(db, printer_id)
    data = payload.model_dump(exclude_unset=True)
    if "access_code" in data:
        code = (data.pop("access_code") or "").strip()
        if code not in ("", _REDACTED_SENTINEL):
            printer.access_code_enc = encrypt_secret(settings, code)
        elif code == _REDACTED_SENTINEL and not printer.access_code_enc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                'Cannot set access code to the placeholder "***"; enter the real code.',
            )
        # blank, or sentinel-with-a-stored-code -> keep the existing ciphertext
    for key, value in data.items():
        setattr(printer, key, value)
    await db.commit()
    await db.refresh(printer)
    return PrinterOut.from_model(printer)


@router.delete("/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_printer(printer_id: int, db: AsyncSession = Depends(get_db)) -> None:
    printer = await _get_or_404(db, printer_id)
    # print_jobs FK printers.id -- remove this printer's history first.
    await db.execute(sa_delete(PrintJob).where(PrintJob.printer_id == printer_id))
    await db.delete(printer)
    await db.commit()


@router.post("/{printer_id}/test", response_model=ProbeOut)
async def test_printer(
    printer_id: int,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ProbeOut:
    printer = await _get_or_404(db, printer_id)
    conn = connection_from_printer(settings, printer)  # decrypts here only
    adapter = build_adapter(printer.kind, conn)
    result = await anyio.to_thread.run_sync(adapter.test_connection)
    return ProbeOut(ok=result.ok, detail=result.detail, gcode_state=result.gcode_state)


@router.post("/{printer_id}/print", status_code=status.HTTP_201_CREATED, response_model=PrintJobOut)
async def start_print(
    printer_id: int,
    payload: PrintRequest,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PrintJobOut:
    """Fast pre-checks only (SPEC "Printer integration"; Task 6): a cheap
    format check (no archive read) and a Redis preflight read. Both are
    re-checked AUTHORITATIVELY inside ``send_to_printer`` itself -- this
    endpoint only ever creates the ``print_jobs`` row and enqueues the task;
    every heavy step (fetching the file, opening the archive, the FTPS
    upload, the MQTT start) happens in the worker, never on the request
    path.
    """
    printer = await _get_or_404(db, printer_id)
    if not printer.enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "printer is disabled")
    file = await db.get(File, payload.file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
    blob = await db.get(Blob, file.blob_hash)
    if blob is None or blob.format != BlobFormat.GCODE_3MF:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "only sliced .gcode.3mf files can be sent to a printer",
        )
    client = aioredis.Redis.from_url(settings.redis_url)
    try:
        state = await read_state_async(client, printer_id)
    finally:
        await client.aclose()
    if not preflight_ok(state):
        gs = state.get("gcode_state") if state else "unknown"
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"printer not ready (state={gs}); must be IDLE/FINISH/FAILED"
        )
    job = PrintJob(
        printer_id=printer_id,
        file_id=file.id,
        state=PrintJobState.QUEUED,
        subtask_name=payload.subtask_name,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    send_to_printer.apply_async(args=[job.id, payload.model_dump()])
    await db.refresh(job)  # eager mode already ran the task through its own sync session
    return PrintJobOut.from_model(job)
