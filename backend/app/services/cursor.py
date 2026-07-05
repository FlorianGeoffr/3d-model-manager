"""Opaque keyset-pagination cursor (M1 Global Constraints: "Pagination").

Cursor = urlsafe-base64 of ``"{sort_value}|{id}"`` where ``sort_value`` is
either an ISO datetime string or a plain sort field (e.g. a name) -- the
caller decides how to interpret the decoded string based on which field it
sorted by. Opaque to clients; malformed input always raises the same 400.
"""

from __future__ import annotations

import base64
import binascii

from fastapi import HTTPException, status


def encode_cursor(sort_value: str, row_id: int) -> str:
    raw = f"{sort_value}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def decode_cursor(cursor: str) -> tuple[str, int]:
    """Decode a cursor into ``(sort_value, row_id)``, or raise 400."""
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        value, id_part = raw.rsplit("|", 1)
        return value, int(id_part)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid cursor") from exc
