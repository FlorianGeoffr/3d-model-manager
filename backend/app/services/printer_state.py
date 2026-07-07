"""Preflight state helper (SPEC "Printer integration"; RESEARCH §4). The
send flow (API pre-check + the ``send_to_printer`` task's authoritative
re-check) both read printerd's merged state from Redis (``app.printers.base
.state_key``) and must agree a print may only start while ``gcode_state`` is
one of ``ALLOWED_PREFLIGHT_STATES`` -- an absent/unparseable state is always
treated as NOT ready (printerd not running, or the printer has never
reported in), never as an implicit pass.
"""

from __future__ import annotations

import json

from app.printers.base import state_key

ALLOWED_PREFLIGHT_STATES = {"IDLE", "FINISH", "FAILED"}  # RESEARCH §4


def preflight_ok(state: dict | None) -> bool:
    return bool(state) and state.get("gcode_state") in ALLOWED_PREFLIGHT_STATES


def read_state_sync(redis_client, printer_id: int) -> dict | None:
    raw = redis_client.get(state_key(printer_id))
    return json.loads(raw) if raw else None


async def read_state_async(redis_client, printer_id: int) -> dict | None:
    raw = await redis_client.get(state_key(printer_id))
    return json.loads(raw) if raw else None
