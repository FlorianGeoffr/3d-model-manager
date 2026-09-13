"""add materials, model metadata/print_tips, printer build_volume, doc kind

R13c: `materials(id, name UNIQUE, kind, color, vendor, notes, created_at)` --
a user-defined filament/resin catalog, distinct from `prints.filament` (a
free-text per-print snapshot kept for backward compatibility and for prints
never resolved to a material row). `prints.material_id` is `ON DELETE SET
NULL` -- deleting a material must not delete print history.

`models.metadata_json` (API field `metadata`; `metadata` itself is a
reserved attribute name on `Base`) is free-form user key/value data, bounds
enforced at the schema layer. `models.print_tips` is a plain text field.

`printers.build_volume_mm` (`{x,y,z}`) backs `GcodePreview`'s build-plate
render; seeded from a small model-name map on create
(`app.schemas.printers.seed_build_volume_mm`), editable afterward.

`BlobKind.DOC` + `BlobFormat.{pdf,md,txt,docx}` (Risk resolution 5): both are
`sa.Enum(..., native_enum=False, create_constraint=True)` -- a VARCHAR plus a
CHECK constraint (see `c69140b3976b_add_webp_blob_format.py`), so widening
is drop-and-recreate the CHECK constraint, no column-type change. Neither
column needs widening: `format` is already sized off `"gcode_3mf"` (9 chars,
> `"docx"`'s 4) and `kind` off `"sliced"`/`"mesh"` (> `"doc"`'s 3).

Revision ID: f3a1c9d2e8b7
Revises: 2490bc11a7f5
Create Date: 2026-09-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3a1c9d2e8b7"
down_revision: str | Sequence[str] | None = "2490bc11a7f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KIND_CONSTRAINT = "ck_blobs_blob_kind"
_FORMAT_CONSTRAINT = "ck_blobs_blob_format"
_OLD_KINDS = ("mesh", "cad", "sliced", "gcode", "image", "other")
_NEW_KINDS = (*_OLD_KINDS[:-1], "doc", "other")
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
    "other",
)
_NEW_FORMATS = (*_OLD_FORMATS[:-1], "pdf", "md", "txt", "docx", "other")


def _in_clause(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "materials",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=True),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column("vendor", sa.String(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_materials_name"),
    )

    op.add_column("prints", sa.Column("material_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        "fk_prints_material_id_materials",
        "prints",
        "materials",
        ["material_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_prints_material_id", "prints", ["material_id"])

    op.add_column("models", sa.Column("metadata_json", postgresql.JSONB(), nullable=True))
    op.add_column("models", sa.Column("print_tips", sa.Text(), nullable=True))

    op.add_column("printers", sa.Column("build_volume_mm", postgresql.JSONB(), nullable=True))

    op.drop_constraint(op.f(_KIND_CONSTRAINT), "blobs", type_="check")
    op.create_check_constraint(op.f(_KIND_CONSTRAINT), "blobs", _in_clause("kind", _NEW_KINDS))
    op.drop_constraint(op.f(_FORMAT_CONSTRAINT), "blobs", type_="check")
    op.create_check_constraint(
        op.f(_FORMAT_CONSTRAINT), "blobs", _in_clause("format", _NEW_FORMATS)
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f(_FORMAT_CONSTRAINT), "blobs", type_="check")
    op.create_check_constraint(
        op.f(_FORMAT_CONSTRAINT), "blobs", _in_clause("format", _OLD_FORMATS)
    )
    op.drop_constraint(op.f(_KIND_CONSTRAINT), "blobs", type_="check")
    op.create_check_constraint(op.f(_KIND_CONSTRAINT), "blobs", _in_clause("kind", _OLD_KINDS))

    op.drop_column("printers", "build_volume_mm")

    op.drop_column("models", "print_tips")
    op.drop_column("models", "metadata_json")

    op.drop_index("ix_prints_material_id", table_name="prints")
    op.drop_constraint("fk_prints_material_id_materials", "prints", type_="foreignkey")
    op.drop_column("prints", "material_id")

    op.drop_table("materials")
