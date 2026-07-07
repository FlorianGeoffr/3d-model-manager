"""Connection-test probe (Task 6 brief step 1): a throwaway write/read/
delete round-trip against a candidate storage backend, used by ``POST
/api/settings/storage/test`` to validate connection details before an
operator commits to them via ``PUT``/``migrate``.

Fails SOFT: any exception raised by the backend (bad credentials, unreachable
host, wrong bucket, ...) is caught and converted into ``(False, str(exc),
elapsed_ms)`` rather than propagating -- a dead endpoint must surface to the
client as a normal ``ok=false`` response, never a 500.
"""

from __future__ import annotations

import contextlib
import time
import uuid

from app.storage.base import StorageBackend

_PROBE_BYTES = b"tdmm-probe"


def probe_backend(backend: StorageBackend) -> tuple[bool, str, int]:
    """Write a tiny throwaway key, read it back, then delete it.

    Kept to a handful of bytes under a distinctive ``.tdmm-probe-<uuid>``
    name so it works even against a fresh, empty backend and never collides
    with real library content.
    """
    key = f".tdmm-probe-{uuid.uuid4().hex}"
    start = time.monotonic()
    try:
        backend.write(key, [_PROBE_BYTES])
        try:
            read_back = b"".join(backend.read(key))
            if read_back != _PROBE_BYTES:
                raise ValueError(
                    f"probe round-trip mismatch: wrote {_PROBE_BYTES!r}, read {read_back!r}"
                )
        finally:
            # Best-effort cleanup even if the read above failed -- a probe
            # key left behind on a otherwise-successful write is just a few
            # stray bytes, not worth masking the real error over.
            with contextlib.suppress(Exception):
                backend.delete(key)
    except Exception as exc:
        return False, str(exc), int((time.monotonic() - start) * 1000)
    return True, "ok", int((time.monotonic() - start) * 1000)
