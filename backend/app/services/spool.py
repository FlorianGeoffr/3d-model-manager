"""Upload spool directory (SPEC "Upload flow", Task 6 interface decisions).

Raw upload bytes land at ``{data_dir}/spool/{token}`` while being teed to
blake3, before any blob/file row exists yet. The token used for a given
upload's spool filename is the SAME uuid later used as the ``jobs.id`` for
the ``store_to_backend`` job created once the upload completes (see
``app.api.uploads``) -- so a job's spool file can always be found again from
just the job id, e.g. for ``POST /api/jobs/{id}/retry``.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from app.config import Settings

SPOOL_DIRNAME = "spool"


def spool_dir(settings: Settings) -> Path:
    """The spool directory's path (not guaranteed to exist -- see
    ``ensure_spool_dir``).
    """
    return Path(settings.data_dir) / SPOOL_DIRNAME


def ensure_spool_dir(settings: Settings) -> Path:
    """Create the spool directory if missing; idempotent.

    Called from the app lifespan on startup, and defensively before every
    upload (some test setups exercise the API without running the lifespan).
    """
    directory = spool_dir(settings)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def spool_path(settings: Settings, token: uuid.UUID | str) -> Path:
    """The path a given upload token's spool file lives (or would live) at."""
    return spool_dir(settings) / str(token)
