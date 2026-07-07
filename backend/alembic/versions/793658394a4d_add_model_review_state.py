"""add model review_state

Revision ID: 793658394a4d
Revises: 2a2ad98de9a4
Create Date: 2026-07-06 23:37:01.090743

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "793658394a4d"
down_revision: str | Sequence[str] | None = "2a2ad98de9a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("models", sa.Column("review_state", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("models", "review_state")
