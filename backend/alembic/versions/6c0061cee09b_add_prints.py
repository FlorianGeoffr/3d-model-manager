"""add prints table for per-model print history

Branch 5 Task 1: a user-entered log of print attempts against a model,
distinct from the ``print_queue`` "to print" worklist (Branch 4 Task 1) and
``print_jobs``' live send-to-printer telemetry (M4). ``printer_name`` is a
plain TEXT snapshot, NOT an FK to ``printers`` -- printers are deletable and
this history must survive their removal.

Enums are ``native_enum=False`` per project convention (VARCHAR + CHECK), so
there is no PG ENUM type to create or drop here.

Revision ID: 6c0061cee09b
Revises: da3e6ab236c6
Create Date: 2026-07-11 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "6c0061cee09b"
down_revision: str | Sequence[str] | None = "da3e6ab236c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "prints",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("model_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "printed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("printer_name", sa.Text(), nullable=True),
        sa.Column("filament", sa.Text(), nullable=True),
        sa.Column(
            "result",
            sa.Enum(
                "success",
                "fail",
                "partial",
                name="print_result",
                native_enum=False,
                create_constraint=True,
            ),
            server_default=sa.text("'success'"),
            nullable=False,
        ),
        sa.Column("duration_min", sa.Integer(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["model_id"],
            ["models.id"],
            name=op.f("fk_prints_model_id_models"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prints")),
    )
    op.create_index(op.f("ix_prints_model_id"), "prints", ["model_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_prints_model_id"), table_name="prints")
    op.drop_table("prints")
