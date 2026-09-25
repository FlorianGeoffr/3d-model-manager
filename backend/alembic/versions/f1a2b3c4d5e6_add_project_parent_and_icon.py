"""Add parent_id and icon to projects table.

Revision ID: f1a2b3c4d5e6
Revises: e5b9c1d2e3f4
Create Date: 2026-09-21 18:20:00.000000

"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "f1a2b3c4d5e6"
down_revision = "e5b9c1d2e3f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("icon", sa.String(), nullable=True))
    op.add_column(
        "projects",
        sa.Column(
            "parent_id",
            sa.BigInteger(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index("ix_projects_parent_id", "projects", ["parent_id"])


def downgrade() -> None:
    op.drop_index("ix_projects_parent_id", table_name="projects")
    op.drop_column("projects", "parent_id")
    op.drop_column("projects", "icon")
