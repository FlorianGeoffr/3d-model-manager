"""add color to tags

R11-C item 16: nullable ``color`` on ``tags``, a palette key
(slate/red/orange/amber/green/teal/blue/indigo/violet/pink) rather than a
free-form value -- the frontend maps it straight to a fixed Tailwind class
pair (``app/lib/tagColors.ts``), so anything else would just fail to render.
Enforced at the API layer (``TagColor`` Literal, 422 on a bad value); a CHECK
constraint backs it up at the DB layer too, since this column is also
writable via bulk/service code paths, not only the single-tag endpoints.

Revision ID: c1a2b3d4e5f6
Revises: 1166a38980c9
Create Date: 2026-09-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1a2b3d4e5f6"
down_revision: str | Sequence[str] | None = "1166a38980c9"
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


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("tags", sa.Column("color", sa.String(), nullable=True))
    op.create_check_constraint(
        "ck_tags_color_palette",
        "tags",
        sa.or_(sa.column("color").in_(_PALETTE), sa.column("color").is_(None)),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("ck_tags_color_palette", "tags", type_="check")
    op.drop_column("tags", "color")
