"""add favorites and print queue

Branch 4 Task 1: a user-starred ``models.favorite`` flag (gallery filter
facet, mirrors ``source_collection_id``/``format``), and a new ``print_queue``
table backing an ordered "models to print" worklist.

Revision ID: 676fe0585c15
Revises: 119e5c77dc8d
Create Date: 2026-07-11 16:09:19.871298

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "676fe0585c15"
down_revision: str | Sequence[str] | None = "119e5c77dc8d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "models",
        sa.Column("favorite", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index(op.f("ix_models_favorite"), "models", ["favorite"], unique=False)

    op.create_table(
        "print_queue",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("model_id", sa.BigInteger(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["model_id"],
            ["models.id"],
            name=op.f("fk_print_queue_model_id_models"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_print_queue")),
        sa.UniqueConstraint("model_id", name=op.f("uq_print_queue_model_id")),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("print_queue")

    op.drop_index(op.f("ix_models_favorite"), table_name="models")
    op.drop_column("models", "favorite")
