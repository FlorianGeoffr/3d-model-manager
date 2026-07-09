"""add imports (site, external_id) dedup lookup index

Backs the M8 H cross-import de-duplication guard
(``app.services.import_dedup``), which resolves a remote model's identity pair
on every manual import and on every periodic collection-sync item.

Deliberately NOT unique: an install that predates the guard may already hold
duplicate ``done`` imports for one pair, and a unique index would make this
migration fail on their data. See the service module's docstring.

Revision ID: e4f1a9c73b28
Revises: c955c2b61b3e
Create Date: 2026-07-09 10:20:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e4f1a9c73b28"
down_revision: str | Sequence[str] | None = "c955c2b61b3e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_index(
        "ix_imports_site_external_id", "imports", ["site", "external_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_imports_site_external_id", table_name="imports")
