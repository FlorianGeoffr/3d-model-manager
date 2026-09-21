"""add projects and print tracking

Revision ID: e5b9c1d2e3f4
Revises: d4a8e2b1c7f9
Create Date: 2026-09-21 14:00:00.000000

Adds projects table for grouping models into projects/folders with progress tracking,
and adds project_id, print_status, quantity_target, and quantity_printed to models.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e5b9c1d2e3f4"
down_revision: str | Sequence[str] | None = "d4a8e2b1c7f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PALETTE = (
    "slate",
    "red",
    "orange",
    "amber",
    "green",
    "teal",
    "blue",
    "indigo",
    "violet",
    "pink",
)

_PRINT_STATUSES = (
    "idle",
    "to_print",
    "printing",
    "printed",
    "finishing",
    "failed",
)


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_projects_name"),
        sa.UniqueConstraint("slug", name="uq_projects_slug"),
    )
    op.create_check_constraint(
        "ck_projects_color_palette",
        "projects",
        sa.or_(sa.column("color").in_(_PALETTE), sa.column("color").is_(None)),
    )

    op.add_column("models", sa.Column("project_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        "fk_models_project_id_projects",
        "models",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_models_project_id", "models", ["project_id"])

    op.add_column("models", sa.Column("print_status", sa.String(), nullable=True))
    op.create_index("ix_models_print_status", "models", ["print_status"])
    op.create_check_constraint(
        "ck_models_print_status",
        "models",
        sa.or_(sa.column("print_status").in_(_PRINT_STATUSES), sa.column("print_status").is_(None)),
    )

    op.add_column(
        "models",
        sa.Column("quantity_target", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_check_constraint(
        "ck_models_quantity_target",
        "models",
        sa.column("quantity_target") >= 1,
    )

    op.add_column(
        "models",
        sa.Column("quantity_printed", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_models_quantity_printed",
        "models",
        sa.column("quantity_printed") >= 0,
    )


def downgrade() -> None:
    op.drop_constraint("ck_models_quantity_printed", "models", type_="check")
    op.drop_column("models", "quantity_printed")

    op.drop_constraint("ck_models_quantity_target", "models", type_="check")
    op.drop_column("models", "quantity_target")

    op.drop_constraint("ck_models_print_status", "models", type_="check")
    op.drop_index("ix_models_print_status", table_name="models")
    op.drop_column("models", "print_status")

    op.drop_index("ix_models_project_id", table_name="models")
    op.drop_constraint("fk_models_project_id_projects", "models", type_="foreignkey")
    op.drop_column("models", "project_id")

    op.drop_constraint("ck_projects_color_palette", "projects", type_="check")
    op.drop_table("projects")
