"""Bambu Studio export filename -> model name (Round 8 Task 4: Bambu Studio
post-processing intake). Pure, stdlib-only -- no I/O, no DB -- so it's
trivially unit-testable and shared verbatim by both the async intake path
(``app.services.slicer_intake.resolve_and_attach``) and its sync twin (the
T5 watcher).

Bambu Studio's default export naming embeds slicing metadata straight into
the filename, e.g. ``Part 5_PLA_6h15m.gcode`` or
``X_plate_2.gcode.3mf`` -- this module strips that back down to the plain
project name a human would recognize, so a slicer upload lands on (or
creates) a sensibly-named model instead of one called
``"Part 5_PLA_6h15m"``.
"""

from __future__ import annotations

import re

# Longest-first: ``.gcode.3mf`` must be checked before the plain ``.gcode``/
# ``.3mf`` cases, exactly like ``app.services.layout.infer_blob_kind_format``
# -- otherwise a sliced ``Benchy.gcode.3mf`` would match plain ``.3mf`` first
# and strip down to the wrong stem ``Benchy.gcode``.
_KNOWN_EXTS: tuple[str, ...] = (
    ".gcode.3mf",
    ".gcode",
    ".3mf",
    ".stl",
    ".obj",
    ".step",
    ".stp",
    ".iges",
    ".igs",
)

# A Bambu material code: 2-6 letters, optionally followed by a `+` (e.g.
# `PLA+`) or a `-XX`/`-XXX` blend suffix (e.g. `PETG-CF`, `ABS-GF`).
_MATERIAL = r"[A-Za-z]{2,6}(?:\+|-[A-Za-z]{2,3})?"
# A Bambu print-time code: `<h>h<m>m[<s>s]` or plain `<m>m[<s>s]`.
_DURATION = r"\d+h\d+m(?:\d+s)?|\d+m(?:\d+s)?"

# Anchored at the END of the (already extension-stripped) stem, case
# -insensitive: either a `_<material>_<duration>` pair (both present -- a
# material code alone, with no duration, is deliberately left untouched,
# since it's ambiguous with a genuine project name that happens to contain
# an underscore-separated word), or a `_plate_<N>` multi-plate export
# suffix.
_EXPORT_SUFFIX_RE = re.compile(
    rf"(?:_{_MATERIAL}_(?:{_DURATION})|_plate_\d+)$",
    re.IGNORECASE,
)


def _safe_basename(filename: str) -> str:
    """Basename of ``filename`` across BOTH ``/`` and ``\\`` separators --
    Bambu Studio typically runs on Windows, so a raw Windows-style path
    could otherwise sail through a POSIX-only split untouched. Rejects an
    empty name, or one that's just ``.``/``..`` (a filename with no real
    basename component at all).
    """
    normalized = filename.replace("\\", "/")
    name = normalized.rsplit("/", 1)[-1]
    if name in ("", ".", ".."):
        raise ValueError(f"unsafe filename: {filename!r}")
    return name


def strip_known_ext(name: str) -> str:
    """Strip the longest matching KNOWN export extension (``_KNOWN_EXTS``,
    case-insensitive). An unrecognized extension falls back to stripping
    just the last ``.suffix``, if ``name`` has one at all -- a bare name
    with no dot is returned unchanged.
    """
    lower = name.lower()
    for ext in _KNOWN_EXTS:
        if lower.endswith(ext):
            return name[: -len(ext)]
    stem, dot, _rest = name.rpartition(".")
    return stem if dot else name


def model_name_from_filename(filename: str) -> str:
    """The plain project name Bambu Studio's export filename was built
    from: safe basename -> strip the known export extension -> strip a
    trailing slicing-metadata suffix (material+duration, or a
    ``_plate_<N>`` multi-plate marker) -> ``.strip()``.

    Callers should fall back to a generic placeholder name (e.g.
    ``"Imported model"``) when this returns an empty string (a filename
    that was ENTIRELY slicing metadata, however unlikely).
    """
    base = _safe_basename(filename)
    stem = strip_known_ext(base)
    stripped = _EXPORT_SUFFIX_RE.sub("", stem)
    return stripped.strip()
