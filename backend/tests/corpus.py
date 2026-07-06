"""Deterministic, procedurally-generated test corpus (SPEC "Processing
pipeline"; RESEARCH §1/§3 tooling notes). Everything here is built at test
time -- nothing binary is checked in.

All the mesh-bearing fixtures below (STL/OBJ/both 3MF flavors/STEP/IGES)
describe the *same* 20x10x5 mm box, matching
``trimesh.creation.box(extents=(20.0, 10.0, 5.0))``: 8 vertices, 12
triangles, watertight, volume 1.0 cm^3, surface area 7.0 cm^2. The two
hand-built 3MF ZIPs exist to exercise the exact trimesh/lib3mf split this
project relies on (RESEARCH §1): ``box_3mf_generic`` is core-spec, inline
mesh -- trimesh reads it natively. ``box_3mf_bambu`` mimics Bambu Studio's
actual Production-Extension layout -- geometry lives in a separate part,
referenced from the root model's ``<build><item p:path="...">`` -- which
trimesh's reader cannot follow (it only resolves ``p:path`` on
``<component>`` elements, never on ``<build><item>``), so it proves the
lib3mf fallback is load-bearing rather than incidental.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import trimesh
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.IGESControl import IGESControl_Writer
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from PIL import Image

# -- shared cube geometry (used inline by both 3MF builders) ----------------

# Same box as `trimesh.creation.box(extents=(20.0, 10.0, 5.0))`: centered on
# the origin, so bounds are [-10,-5,-2.5]..[10,5,2.5].
_CUBE_VERTICES = [
    (-10.0, -5.0, -2.5),
    (10.0, -5.0, -2.5),
    (10.0, 5.0, -2.5),
    (-10.0, 5.0, -2.5),
    (-10.0, -5.0, 2.5),
    (10.0, -5.0, 2.5),
    (10.0, 5.0, 2.5),
    (-10.0, 5.0, 2.5),
]

# Outward-facing (right-hand-rule) winding per face, two triangles each:
# bottom, top, front, back, left, right.
_CUBE_TRIANGLES = [
    (0, 3, 2),
    (0, 2, 1),
    (4, 5, 6),
    (4, 6, 7),
    (0, 1, 5),
    (0, 5, 4),
    (3, 7, 6),
    (3, 6, 2),
    (0, 4, 7),
    (0, 7, 3),
    (1, 6, 5),
    (1, 2, 6),
]

_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="model" '
    'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    '<Default Extension="png" ContentType="image/png"/>'
    "</Types>"
)

_ROOT_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rel0" '
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" '
    'Target="/3D/3dmodel.model"/>'
    "</Relationships>"
)


def _cube_mesh_xml() -> str:
    """The ``<mesh>`` fragment for the shared cube, ready to embed inside an
    ``<object>`` element.
    """
    vertices = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in _CUBE_VERTICES)
    triangles = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in _CUBE_TRIANGLES)
    return f"<mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh>"


def _write_zip(members: dict[str, str | bytes]) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in members.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _solid_png(size: int, color: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (size, size), color)
    buf = BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


# -- mesh formats -------------------------------------------------------


def box_stl() -> bytes:
    """A 20x10x5 mm box, exported to binary STL via trimesh."""
    box = trimesh.creation.box(extents=(20.0, 10.0, 5.0))
    return box.export(file_type="stl")


def box_obj() -> bytes:
    """The same box, exported to OBJ via trimesh."""
    box = trimesh.creation.box(extents=(20.0, 10.0, 5.0))
    return box.export(file_type="obj").encode()


def box_3mf_generic() -> bytes:
    """A hand-built, core-spec 3MF (no Production Extension): the cube mesh
    is defined inline in the root ``3D/3dmodel.model`` -- exactly the shape
    trimesh's loader handles natively.
    """
    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        "<resources>"
        f'<object id="1" type="model">{_cube_mesh_xml()}</object>'
        "</resources>"
        '<build><item objectid="1"/></build>'
        "</model>"
    )
    return _write_zip(
        {
            "[Content_Types].xml": _CONTENT_TYPES_XML,
            "_rels/.rels": _ROOT_RELS_XML,
            "3D/3dmodel.model": model_xml,
        }
    )


def box_3mf_bambu() -> bytes:
    """A hand-built Production-Extension 3MF, shaped like Bambu Studio's
    project files: the root ``3D/3dmodel.model`` has an empty
    ``<resources/>`` and NO inline mesh -- its ``<build>`` item points at a
    separate part (``3D/Objects/object_1.model``, holding the actual cube)
    via the Production Extension's ``p:path`` attribute, with a matching
    relationship declared in ``3D/_rels/3dmodel.model.rels``.
    """
    root_model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
        'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" '
        'requiredextensions="p">'
        "<resources/>"
        '<build><item objectid="1" p:path="/3D/Objects/object_1.model"/></build>'
        "</model>"
    )
    object_model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        "<resources>"
        f'<object id="1" type="model">{_cube_mesh_xml()}</object>'
        "</resources>"
        "<build/>"
        "</model>"
    )
    object_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rel1" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" '
        'Target="/3D/Objects/object_1.model"/>'
        "</Relationships>"
    )
    return _write_zip(
        {
            "[Content_Types].xml": _CONTENT_TYPES_XML,
            "_rels/.rels": _ROOT_RELS_XML,
            "3D/3dmodel.model": root_model_xml,
            "3D/_rels/3dmodel.model.rels": object_rels_xml,
            "3D/Objects/object_1.model": object_model_xml,
        }
    )


# -- sliced Bambu gcode.3mf ------------------------------------------------


def bambu_gcode() -> bytes:
    """A Bambu Studio gcode HEADER_BLOCK, as embedded in ``plate_N.gcode``
    inside a sliced ``.gcode.3mf`` (RESEARCH §3).
    """
    return (
        b"; HEADER_BLOCK_START\n"
        b"; BambuStudio 02.00.00.00\n"
        b"; model printing time: 55m 30s; total estimated time: 1h 1m 30s\n"
        b"; total layer number: 175\n"
        b"; total filament length [mm] : 4820.5\n"
        b"; total filament weight [g] : 12.50\n"
        b"; max_z_height: 35.00\n"
        b"; HEADER_BLOCK_END\n"
        b"G28\n"
    )


def sliced_gcode_3mf() -> bytes:
    """A hand-built sliced ``.gcode.3mf``, shaped like a 2-plate Bambu Studio
    export (RESEARCH §3 key names): ``Metadata/slice_info.config`` (per-plate
    ``<metadata key="index|prediction|weight"/>`` + ``<filament>``),
    ``Metadata/project_settings.config`` (JSON slicer settings),
    ``Metadata/model_settings.config`` (per-plate gcode/thumbnail paths),
    ready-made plate thumbnail PNGs, one plate's gcode (see ``bambu_gcode``),
    and a stub geometry-free ``3D/3dmodel.model`` (sliced exports keep no
    real geometry).

    Only ``plate_1.gcode`` is included (plate 2's gcode is omitted
    deliberately, per the task brief) -- the fixture still exercises
    multi-plate ``slice_info.config``/``model_settings.config`` parsing
    without needing every plate's gcode on disk.
    """
    slice_info_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<config>"
        "<header>"
        '<header_item key="X-BBL-Client-Type" value="slicer"/>'
        '<header_item key="X-BBL-Client-Version" value="02.00.00.00"/>'
        "</header>"
        "<plate>"
        '<metadata key="index" value="1"/>'
        '<metadata key="printer_model_id" value="C11"/>'
        '<metadata key="nozzle_diameters" value="0.4"/>'
        '<metadata key="prediction" value="3600"/>'
        '<metadata key="weight" value="12.50"/>'
        '<filament id="1" type="PLA" color="#FF0000" used_m="4.82" used_g="12.50"/>'
        "</plate>"
        "<plate>"
        '<metadata key="index" value="2"/>'
        '<metadata key="printer_model_id" value="C11"/>'
        '<metadata key="nozzle_diameters" value="0.4"/>'
        '<metadata key="prediction" value="1800"/>'
        '<metadata key="weight" value="7.50"/>'
        '<filament id="1" type="PETG" color="#0000FF" used_m="2.41" used_g="7.50"/>'
        "</plate>"
        "</config>"
    )
    project_settings_json = (
        '{"printer_model": "Bambu Lab A1 mini", "printer_variant": "0.4", '
        '"layer_height": "0.2", "filament_type": ["PLA", "PETG"]}'
    )
    model_settings_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<config>"
        "<plate>"
        '<metadata key="plater_id" value="1"/>'
        '<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>'
        '<metadata key="thumbnail_file" value="Metadata/plate_1.png"/>'
        "</plate>"
        "<plate>"
        '<metadata key="plater_id" value="2"/>'
        '<metadata key="gcode_file" value="Metadata/plate_2.gcode"/>'
        '<metadata key="thumbnail_file" value="Metadata/plate_2.png"/>'
        "</plate>"
        "</config>"
    )
    stub_model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        "<resources/>"
        "<build/>"
        "</model>"
    )
    return _write_zip(
        {
            "[Content_Types].xml": _CONTENT_TYPES_XML,
            "_rels/.rels": _ROOT_RELS_XML,
            "3D/3dmodel.model": stub_model_xml,
            "Metadata/slice_info.config": slice_info_xml,
            "Metadata/project_settings.config": project_settings_json,
            "Metadata/model_settings.config": model_settings_xml,
            "Metadata/plate_1.png": _solid_png(32, (255, 0, 0)),
            "Metadata/plate_2.png": _solid_png(32, (0, 0, 255)),
            "Metadata/plate_1.gcode": bambu_gcode(),
        }
    )


# -- CAD formats ----------------------------------------------------------


def box_step(path: Path) -> None:
    """Write the same 20x10x5 mm box to ``path`` as STEP, via a real OCCT
    B-Rep writer (STEP isn't worth hand-authoring like the 3MF XML above).
    """
    shape = BRepPrimAPI_MakeBox(20.0, 10.0, 5.0).Shape()
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    writer.Write(str(path))


def box_iges(path: Path) -> None:
    """Write the same box to ``path`` as IGES, via OCCT."""
    shape = BRepPrimAPI_MakeBox(20.0, 10.0, 5.0).Shape()
    writer = IGESControl_Writer()
    writer.AddShape(shape)
    writer.ComputeModel()
    writer.Write(str(path))


# -- images -----------------------------------------------------------------


def red_png() -> bytes:
    """A plain 64x64 solid-red PNG."""
    return _solid_png(64, (255, 0, 0))


# -- on-disk corpus -----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CorpusPaths:
    """Paths to one on-disk copy of every builder above's output (see the
    session-scoped ``corpus`` fixture in conftest.py). Pipeline steps (Tasks
    2+) take file paths, not in-memory bytes, so tests exercising them need
    real files rather than the raw ``bytes`` the builders themselves return.
    """

    box_stl: Path
    box_obj: Path
    box_3mf_generic: Path
    box_3mf_bambu: Path
    sliced_gcode_3mf: Path
    bambu_gcode: Path
    box_step: Path
    box_iges: Path
    red_png: Path
