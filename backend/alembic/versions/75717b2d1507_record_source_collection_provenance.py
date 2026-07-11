"""record source collection provenance

Branch 3 Task 1: thread the followed collection an import came from through to
``imports.collection_id`` and (denormalized, so it survives unfollowing) the
resulting ``models.source_collection_id``/``source_collection_title``.

Revision ID: 75717b2d1507
Revises: 21c7efaee9ef
Create Date: 2026-07-11 14:17:49.195618

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "75717b2d1507"
down_revision: str | Sequence[str] | None = "21c7efaee9ef"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("imports", sa.Column("collection_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        op.f("fk_imports_collection_id_followed_collections"),
        "imports",
        "followed_collections",
        ["collection_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.add_column("models", sa.Column("source_collection_id", sa.BigInteger(), nullable=True))
    op.add_column("models", sa.Column("source_collection_title", sa.Text(), nullable=True))
    op.create_foreign_key(
        op.f("fk_models_source_collection_id_followed_collections"),
        "models",
        "followed_collections",
        ["source_collection_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(
        op.f("fk_models_source_collection_id_followed_collections"), "models", type_="foreignkey"
    )
    op.drop_column("models", "source_collection_title")
    op.drop_column("models", "source_collection_id")

    op.drop_constraint(
        op.f("fk_imports_collection_id_followed_collections"), "imports", type_="foreignkey"
    )
    op.drop_column("imports", "collection_id")
