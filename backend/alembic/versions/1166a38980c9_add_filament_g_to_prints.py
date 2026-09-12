"""add filament_g to prints

R11-B item 14 (print cost estimate): the existing `prints.filament` column
is a free-text snapshot (e.g. "PLA Black"), not a weight -- add a nullable
numeric `filament_g` alongside it so the print-cost estimate (and the
dashboard's `prints.filament_g_total` stat) has an actual grams figure to
sum, without disturbing the free-text field's own meaning.

Revision ID: 1166a38980c9
Revises: b3f1a9c2d4e6
Create Date: 2026-09-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1166a38980c9"
down_revision: str | Sequence[str] | None = "b3f1a9c2d4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("prints", sa.Column("filament_g", sa.Float(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("prints", "filament_g")
