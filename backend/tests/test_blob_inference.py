"""Blob kind/format inference from an upload's ``rel_path`` extension (SPEC
``blobs`` enums; Task 6 interface decision). Pure function, no DB/IO --
covers the ``.gcode.3mf`` double-extension rule explicitly.
"""

import pytest

from app.models.enums import BlobFormat, BlobKind
from app.services.layout import infer_blob_kind_format


@pytest.mark.parametrize(
    ("rel_path", "expected_kind", "expected_format"),
    [
        ("part.stl", BlobKind.MESH, BlobFormat.STL),
        ("PART.STL", BlobKind.MESH, BlobFormat.STL),
        ("model.3mf", BlobKind.MESH, BlobFormat.THREEMF),
        ("print.gcode.3mf", BlobKind.SLICED, BlobFormat.GCODE_3MF),
        ("PRINT.GCODE.3MF", BlobKind.SLICED, BlobFormat.GCODE_3MF),
        ("nested/dir/print.gcode.3mf", BlobKind.SLICED, BlobFormat.GCODE_3MF),
        ("plate_1.gcode", BlobKind.GCODE, BlobFormat.GCODE),
        ("bracket.obj", BlobKind.MESH, BlobFormat.OBJ),
        ("housing.step", BlobKind.CAD, BlobFormat.STEP),
        ("housing.stp", BlobKind.CAD, BlobFormat.STEP),
        ("part.iges", BlobKind.CAD, BlobFormat.IGES),
        ("part.igs", BlobKind.CAD, BlobFormat.IGES),
        ("cover.png", BlobKind.IMAGE, BlobFormat.PNG),
        ("cover.jpg", BlobKind.IMAGE, BlobFormat.JPG),
        ("cover.jpeg", BlobKind.IMAGE, BlobFormat.JPG),
        ("readme.txt", BlobKind.OTHER, BlobFormat.OTHER),
        ("no-extension", BlobKind.OTHER, BlobFormat.OTHER),
    ],
)
def test_infer_blob_kind_format(
    rel_path: str, expected_kind: BlobKind, expected_format: BlobFormat
) -> None:
    kind, format_ = infer_blob_kind_format(rel_path)

    assert kind == expected_kind
    assert format_ == expected_format
