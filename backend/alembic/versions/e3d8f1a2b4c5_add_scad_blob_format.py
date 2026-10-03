"""add scad blob format

Revision ID: e3d8f1a2b4c5
Revises: f1a2b3c4d5e6
Create Date: 2026-10-03 16:30:00.000000

Adds OpenSCAD (`.scad`) support as a CAD blob format.
`blobs.format` is a VARCHAR column backed by the `ck_blobs_blob_format` CHECK
constraint, so extending it drops and re-creates the constraint.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3d8f1a2b4c5"
down_revision: str | Sequence[str] | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT_NAME = "ck_blobs_blob_format"
_OLD_FORMATS = (
    "stl",
    "3mf",
    "obj",
    "step",
    "iges",
    "gcode_3mf",
    "gcode",
    "png",
    "jpg",
    "webp",
    "pdf",
    "md",
    "txt",
    "docx",
    "other",
)
_NEW_FORMATS = (
    "stl",
    "3mf",
    "obj",
    "step",
    "iges",
    "scad",
    "gcode_3mf",
    "gcode",
    "png",
    "jpg",
    "webp",
    "pdf",
    "md",
    "txt",
    "docx",
    "other",
)


def _in_clause(values: tuple[str, ...]) -> str:
    return "format IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f(_CONSTRAINT_NAME), "blobs", type_="check")
    op.create_check_constraint(op.f(_CONSTRAINT_NAME), "blobs", _in_clause(_NEW_FORMATS))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f(_CONSTRAINT_NAME), "blobs", type_="check")
    op.create_check_constraint(op.f(_CONSTRAINT_NAME), "blobs", _in_clause(_OLD_FORMATS))
