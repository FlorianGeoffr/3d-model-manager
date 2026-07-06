"""``convert_to_glb`` pipeline step's per-format conversion (SPEC pipeline row
3; RESEARCH §2): stl/obj/3mf go through ``app.pipeline.meshload`` (already
handling the trimesh/lib3mf split); step/iges go through cascadio/OCP
respectively. This module is pure file-in, file-out conversion -- no DB, no
Celery -- exactly like ``meshload.load_mesh``; ``app.tasks.pipeline`` owns the
derivative/job bookkeeping around it.
"""

from __future__ import annotations

from pathlib import Path

import cascadio
import trimesh

from app.models.enums import BlobFormat
from app.pipeline import cad, meshload

_MESH_FORMATS = (BlobFormat.STL, BlobFormat.OBJ, BlobFormat.THREEMF)

# cascadio's STEP path goes through OCCT's own glTF writer, which -- per the
# glTF 2.0 spec's SI-meter convention -- always emits vertex coordinates in
# meters, regardless of the STEP file's own declared unit (verified
# empirically against this project's corpus: a `write.step.unit`-default
# STEP declaring millimeters comes back with every extent divided by 1000).
# Every OTHER branch here keeps the source's own numeric scale untouched --
# trimesh's GLB writer for stl/obj/3mf, and `cad.iges_to_glb`'s own
# trimesh-based export below, both pass numbers through as-is. Multiplying
# back by 1000 restores that same "1 GLB unit = 1 source unit" (mm, this
# project's working convention) for the STEP branch too. This matters
# concretely: `app.tasks.pipeline._cad_blob_meta` reads `BlobMeta.dims_mm`
# straight off this derivative's `mesh.extents` -- without this correction
# every STEP upload's recorded dimensions would be 1000x too small.
_CASCADIO_METERS_TO_MM = 1000.0


def convert_to_glb_file(src: Path, fmt: BlobFormat, dst: Path) -> str:
    """Convert ``src`` (a temp file carrying its real extension) to a GLB at
    ``dst``, returning the name of the tool that did the conversion.

    Every branch is a deterministic, potentially-failing parse/convert step:
    trimesh/lib3mf exceptions (via ``meshload.load_mesh``), cascadio's own
    exceptions, and ``cad.iges_to_glb``'s ``ValueError``s all propagate to the
    caller uncaught -- ``app.tasks.pipeline``'s ``convert_to_glb`` step maps
    any of them to a failed derivative + failed job (Global Constraints
    "Failure semantics").
    """
    if fmt in _MESH_FORMATS:
        mesh, tool = meshload.load_mesh(src, fmt)
        mesh.export(dst, file_type="glb")
        return tool
    if fmt is BlobFormat.STEP:
        cascadio.step_to_glb(str(src), str(dst), tol_linear=0.1, tol_angular=0.5)
        _rescale_glb_in_place(dst, _CASCADIO_METERS_TO_MM)
        return "cascadio"
    if fmt is BlobFormat.IGES:
        cad.iges_to_glb(src, dst)
        return "cadquery-ocp"
    raise ValueError(f"convert_to_glb_file: unsupported format {fmt}")


def _rescale_glb_in_place(path: Path, factor: float) -> None:
    """Reload the GLB just written to ``path``, scale it by ``factor``, and
    re-export over the same path -- see ``_CASCADIO_METERS_TO_MM`` above.
    """
    mesh = meshload.to_single_mesh(trimesh.load(path))
    mesh.apply_scale(factor)
    mesh.export(path, file_type="glb")
