"""add gallery perf indexes

Revision ID: 80a7c49416df
Revises: 793658394a4d
Create Date: 2026-07-08 02:12:53.835023

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "80a7c49416df"
down_revision: str | Sequence[str] | None = "793658394a4d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index("ix_models_name_id", "models", ["name", "id"])
    op.create_index("ix_models_updated_at_id", "models", ["updated_at", "id"])
    op.create_index("ix_model_tags_tag_id", "model_tags", ["tag_id"])
    op.create_index("ix_blobs_format", "blobs", ["format"])
    op.create_index(
        "ix_blob_meta_print_time_s",
        "blob_meta",
        ["print_time_s"],
        postgresql_where=sa.text("print_time_s IS NOT NULL"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_blob_meta_print_time_s", table_name="blob_meta")
    op.drop_index("ix_blobs_format", table_name="blobs")
    op.drop_index("ix_model_tags_tag_id", table_name="model_tags")
    op.drop_index("ix_models_updated_at_id", table_name="models")
    op.drop_index("ix_models_name_id", table_name="models")
