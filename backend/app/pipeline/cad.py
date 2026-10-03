"""IGES -> GLB conversion via raw OCCT bindings (SPEC pipeline row 3; RESEARCH
§2): ``cascadio`` (used for STEP, see ``app.pipeline.convert``) is STEP-only
-- its README lists IGES as future work -- so IGES goes through
``cadquery-ocp``'s raw OCCT 7.9 bindings directly: read the file, tessellate
every face, and walk the resulting triangulation into one concatenated
``trimesh.Trimesh`` ourselves.

Unlike cascadio's STEP path (which goes through OCCT's own glTF writer and,
per the glTF 2.0 spec's SI-meter convention, always emits coordinates in
meters regardless of the source file's declared unit -- see
``app.pipeline.convert``'s correction for that), this module copies
``BRepMesh_IncrementalMesh``'s triangulation node coordinates directly and
exports them via trimesh's own GLB writer, which -- like trimesh's
stl/obj/3mf export path -- never touches the numeric scale. So the geometry
here keeps the CAD file's own working unit (mm, this project's convention)
untouched, with no correction needed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import trimesh
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.IFSelect import IFSelect_RetDone
from OCP.IGESControl import IGESControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS

from app.pipeline import meshload

# BRepMesh_IncrementalMesh(shape, linear_deflection, is_relative,
# angular_deflection, is_parallel) -- SPEC's tessellation tolerance for the
# IGES branch (RESEARCH §2's "OCCT's IGES healing is the slowest, flakiest
# part of this pipeline" caveat is about reading/healing IGES entities, not
# tessellation tolerance choice).
_LINEAR_DEFLECTION = 0.2
_ANGULAR_DEFLECTION = 0.5


def iges_to_glb(src: Path, dst: Path) -> None:
    """Read the IGES file at ``src``, tessellate it, and export a GLB to
    ``dst``. Raises ``ValueError`` for a file OCCT can't read at all (a
    deterministic parse failure, same convention as
    ``app.pipeline.meshload.load_mesh``) or one that yields no triangulated
    geometry whatsoever.
    """
    reader = IGESControl_Reader()
    if reader.ReadFile(str(src)) != IFSelect_RetDone:
        raise ValueError("IGES read failed")
    reader.TransferRoots()
    shape = reader.OneShape()

    BRepMesh_IncrementalMesh(shape, _LINEAR_DEFLECTION, False, _ANGULAR_DEFLECTION, True)

    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        loc = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, loc)
        if triangulation is None:
            explorer.Next()
            continue

        transform = loc.Transformation()
        offset = len(vertices)
        for i in range(1, triangulation.NbNodes() + 1):
            point = triangulation.Node(i).Transformed(transform)
            vertices.append((point.X(), point.Y(), point.Z()))

        # OCCT triangulation winding is defined in the face's natural
        # (FORWARD) orientation; a REVERSED face needs its two trailing
        # indices swapped to keep every triangle's winding consistently
        # outward-facing once flattened into one mesh.
        reversed_winding = face.Orientation() == TopAbs_REVERSED
        for i in range(1, triangulation.NbTriangles() + 1):
            a, b, c = triangulation.Triangle(i).Get()
            a, b, c = offset + a - 1, offset + b - 1, offset + c - 1
            faces.append((a, c, b) if reversed_winding else (a, b, c))

        explorer.Next()

    if not faces:
        raise ValueError(f"no triangulated faces found in iges: {src}")

    mesh = trimesh.Trimesh(
        vertices=np.array(vertices, dtype=np.float64), faces=np.array(faces, dtype=np.int64)
    )
    mesh.export(dst, file_type="glb")


def find_openscad_binary(configured_path: str = "openscad") -> str | None:
    """Resolve the OpenSCAD executable path.

    Checks:
    1. PATH via `shutil.which`
    2. Direct file path if `configured_path` points to a file
    3. Standard installation directories on Windows / macOS / Linux
    """
    if shutil.which(configured_path):
        return configured_path

    candidate = Path(configured_path)
    if candidate.is_file():
        return str(candidate)

    if sys.platform == "win32":
        standard_windows_paths = [
            r"C:\Program Files\OpenSCAD (Nightly)\openscad.com",
            r"C:\Program Files\OpenSCAD\openscad.com",
            r"C:\Program Files\OpenSCAD (Nightly)\openscad.exe",
            r"C:\Program Files\OpenSCAD\openscad.exe",
            r"C:\Program Files (x86)\OpenSCAD\openscad.com",
            r"C:\Program Files (x86)\OpenSCAD\openscad.exe",
        ]
        for p in standard_windows_paths:
            if Path(p).is_file():
                return p

    if sys.platform == "darwin":
        mac_paths = [
            "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
            str(Path.home() / "Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"),
        ]
        for p in mac_paths:
            if Path(p).is_file():
                return str(p)

    if sys.platform.startswith("linux"):
        standard_linux_paths = [
            "/usr/bin/openscad",
            "/usr/local/bin/openscad",
            "/snap/bin/openscad",
            "/var/lib/flatpak/exports/bin/org.openscad.OpenSCAD",
        ]
        for p in standard_linux_paths:
            if Path(p).is_file():
                return p

    return None


def scad_to_glb(
    src: Path,
    dst: Path,
    *,
    openscad_path: str = "openscad",
    timeout_s: float = 120.0,
) -> None:
    """Compile an OpenSCAD script at ``src`` to STL via OpenSCAD CLI, then
    export it as a GLB to ``dst``.

    Raises ``RuntimeError`` if the OpenSCAD executable cannot be found.
    Raises ``TimeoutError`` if compilation exceeds ``timeout_s``.
    Raises ``ValueError`` if compilation fails or produces no geometry.
    """
    bin_path = find_openscad_binary(openscad_path)
    if not bin_path:
        raise RuntimeError(
            f"OpenSCAD executable not found (configured: '{openscad_path}'). "
            "Please install OpenSCAD and ensure it is available on PATH."
        )

    with tempfile.TemporaryDirectory(prefix="tdmm-scad-") as tmp_dir:
        tmp_stl = Path(tmp_dir) / "output.stl"
        cmd = [bin_path, "-o", str(tmp_stl), str(src.resolve())]
        env = os.environ.copy()

        # In headless Linux environments (Docker containers, CI, headless servers),
        # OpenSCAD (which links to Qt) requires an X server or offscreen platform.
        # When no DISPLAY is set:
        # 1. Prefer xvfb-run if installed (runs virtual X11 framebuffer with software GL).
        # 2. Otherwise fall back to QT_QPA_PLATFORM=offscreen.
        if sys.platform.startswith("linux") and not env.get("DISPLAY"):
            xvfb_run = shutil.which("xvfb-run")
            if xvfb_run:
                cmd = [xvfb_run, "-a", "-s", "-screen 0 1024x768x24", *cmd]
            else:
                env["QT_QPA_PLATFORM"] = "offscreen"

        try:
            res = subprocess.run(
                cmd,
                cwd=src.parent,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                f"OpenSCAD compilation timed out after {timeout_s}s: {src.name}"
            ) from exc

        if res.returncode != 0:
            error_output = (res.stderr or res.stdout or "").strip()
            raise ValueError(
                f"OpenSCAD compilation failed (exit code {res.returncode}): {error_output}"
            )

        if not tmp_stl.exists() or tmp_stl.stat().st_size == 0:
            error_output = (res.stderr or res.stdout or "").strip()
            raise ValueError(f"OpenSCAD produced no output STL: {error_output or 'empty file'}")

        loaded = trimesh.load(tmp_stl, file_type="stl")
        mesh = meshload.to_single_mesh(loaded)

        if len(mesh.faces) == 0:
            raise ValueError(f"OpenSCAD produced empty mesh (no faces): {src.name}")

        mesh.export(dst, file_type="glb")
