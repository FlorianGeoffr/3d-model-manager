"""index models source_collection_id

Branch 3 review (Minor): the gallery's ``collection=`` filter is a plain
equality on ``models.source_collection_id`` -- back it with an index like the
other gallery filter columns (mirrors ``ix_blobs_format`` from the gallery
perf-index revision).

Revision ID: 119e5c77dc8d
Revises: 75717b2d1507
Create Date: 2026-07-11 14:50:00.837665

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "119e5c77dc8d"
down_revision: str | Sequence[str] | None = "75717b2d1507"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        op.f("ix_models_source_collection_id"), "models", ["source_collection_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_models_source_collection_id"), table_name="models")
