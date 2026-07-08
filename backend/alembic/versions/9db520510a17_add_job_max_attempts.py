"""add job max_attempts

Revision ID: 9db520510a17
Revises: 80a7c49416df
Create Date: 2026-07-08 02:25:33.788365

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9db520510a17"
down_revision: str | Sequence[str] | None = "80a7c49416df"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "jobs", sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3")
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("jobs", "max_attempts")
