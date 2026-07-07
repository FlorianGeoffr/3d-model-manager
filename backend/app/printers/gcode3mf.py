from __future__ import annotations

import io
import re
import zipfile

_PLATE_RE = re.compile(r"^Metadata/plate_(\d+)\.gcode$")


class NotSendableError(ValueError):
    """Not a startable sliced .gcode.3mf (bare .gcode, corrupt zip, or no plate gcode)."""


def plates_in_gcode_3mf(data: bytes) -> list[int]:
    """Sorted plate numbers whose gcode is PHYSICALLY present in the archive
    (RESEARCH §4: project_file needs Metadata/plate_N.gcode). Raises
    NotSendableError for a bare .gcode / non-zip / plateless archive."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise NotSendableError(
            "not a .gcode.3mf archive (bare .gcode is rejected for remote start)"
        ) from e
    plates = sorted(int(m.group(1)) for n in zf.namelist() if (m := _PLATE_RE.match(n)))
    if not plates:
        raise NotSendableError("archive contains no Metadata/plate_N.gcode; cannot start a print")
    return plates


def assert_plate_available(data: bytes, plate: int) -> None:
    plates = plates_in_gcode_3mf(data)
    if plate not in plates:
        raise NotSendableError(f"plate {plate} not in archive (available: {plates})")
