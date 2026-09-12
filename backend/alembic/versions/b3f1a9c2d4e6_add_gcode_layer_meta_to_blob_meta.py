"""add gcode layer/infill/slicer metadata to blob_meta

R10-B (plan item 10): PrusaSlicer/OrcaSlicer/Bambu Studio comment-header
metadata (``app.pipeline.gcode_meta``) adds layer count, infill density, and
slicer name -- extending ``blob_meta`` rather than a new table since these
are per-blob scalars alongside the existing sliced-file columns.

Revision ID: b3f1a9c2d4e6
Revises: a718a74f6926
Create Date: 2026-09-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3f1a9c2d4e6"
down_revision: str | Sequence[str] | None = "a718a74f6926"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("blob_meta", sa.Column("layer_count", sa.Integer(), nullable=True))
    op.add_column("blob_meta", sa.Column("infill_pct", sa.Float(), nullable=True))
    op.add_column("blob_meta", sa.Column("slicer", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("blob_meta", "slicer")
    op.drop_column("blob_meta", "infill_pct")
    op.drop_column("blob_meta", "layer_count")
