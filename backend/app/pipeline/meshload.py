"""Mesh loading for the ``extract_metadata`` pipeline step (SPEC pipeline
row 1; RESEARCH §1): trimesh handles STL/OBJ/generic-3MF natively, but its
3MF reader only follows the Production Extension's ``p:path`` attribute on
``<component>`` elements, never on ``<build><item>`` -- exactly how Bambu
Studio/OrcaSlicer project files reference their geometry by default. lib3mf
(the 3MF Consortium's own reference implementation) is the fallback that
DOES understand that layout.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple

import numpy as np
import trimesh

from app.models.enums import BlobFormat


class MeshLoad(NamedTuple):
    mesh: trimesh.Trimesh
    tool: str


def to_single_mesh(loaded: trimesh.Trimesh | trimesh.Scene) -> trimesh.Trimesh:
    """Collapse a trimesh load result to one concatenated ``Trimesh``.

    Multi-object files (OBJ, 3MF, GLB) load as a ``Scene``; ``to_geometry()``
    bakes each geometry's transform and concatenates them into a single
    like-typed geometry. A bare ``Trimesh`` (the common case for
    single-object STL/OBJ) passes through unchanged.
    """
    if isinstance(loaded, trimesh.Scene):
        return loaded.to_geometry()
    return loaded


def load_mesh(path: Path, fmt: BlobFormat) -> MeshLoad:
    """Load ``path`` (a temp file for an stl/obj/3mf blob) into one
    concatenated mesh, reporting which tool actually produced it.

    stl/obj always go through trimesh. 3mf tries trimesh first and falls
    back to :func:`load_3mf_lib3mf` (RESEARCH §1's documented split) whenever
    trimesh's read either raises outright or comes back with zero faces --
    its current behavior on the Production-Extension layout Bambu
    Studio/OrcaSlicer write by default (trimesh returns an empty ``Scene``
    rather than erroring).
    """
    if fmt is not BlobFormat.THREEMF:
        mesh = to_single_mesh(trimesh.load(path))
        if len(mesh.faces) == 0:
            # trimesh doesn't raise on unparseable/garbage content -- it
            # silently comes back with an empty Scene (0 geometries), whose
            # `to_geometry()` is an empty Trimesh with `extents`/`bounds` of
            # `None`. There's no fallback tool for stl/obj (unlike 3mf
            # below), so this has to surface as a clear, explicit failure
            # here rather than crashing downstream on `None` extents.
            raise ValueError(f"no geometry found in {fmt.value} file: {path}")
        return MeshLoad(mesh, "trimesh")

    mesh: trimesh.Trimesh | None = None
    try:
        mesh = to_single_mesh(trimesh.load(path))
    except Exception:  # noqa: BLE001 - any load failure means "fall back to lib3mf"
        mesh = None
    if mesh is not None and len(mesh.faces) > 0:
        return MeshLoad(mesh, "trimesh")
    return MeshLoad(load_3mf_lib3mf(path), "lib3mf")


def load_3mf_lib3mf(path: Path) -> trimesh.Trimesh:
    """Parse ``path`` via lib3mf's reference-implementation reader (RESEARCH
    §1's documented approach): ``Wrapper`` -> ``model`` -> ``GetMeshObjects``
    iterator -> per-object vertices/triangles into numpy -> ``trimesh.Trimesh``
    -> ``trimesh.util.concatenate``. This is the fallback for 3MF geometry
    trimesh's own reader can't follow (Production Extension ``<build><item
    p:path>`` references).
    """
    import lib3mf

    wrapper = lib3mf.get_wrapper()
    model = wrapper.CreateModel()
    reader = model.QueryReader("3mf")
    reader.ReadFromFile(str(path))

    meshes: list[trimesh.Trimesh] = []
    iterator = model.GetMeshObjects()
    while iterator.MoveNext():
        mesh_object = iterator.GetCurrentMeshObject()
        vertices = np.array([v.Coordinates for v in mesh_object.GetVertices()], dtype=np.float64)
        triangles = np.array([t.Indices for t in mesh_object.GetTriangleIndices()], dtype=np.int64)
        if len(vertices) == 0 or len(triangles) == 0:
            continue
        meshes.append(trimesh.Trimesh(vertices=vertices, faces=triangles))

    if not meshes:
        raise ValueError(f"no mesh objects found in 3mf: {path}")
    return trimesh.util.concatenate(meshes)
