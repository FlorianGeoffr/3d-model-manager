"""cache remote collection lists

M10 escape hatch A: ``remote_collection_cache`` holds a read-through cache of
a site's REAL collection list, kept warm by the browser extension's push
(``POST /ext/collections``) and self-healed whenever MakerWorld's own
Cloudflare-walled SSR enumeration route happens to succeed on its own (see
``app.importers.makerworld.MakerWorldImporter.list_user_lists``).

Enums are ``native_enum=False`` per project convention (VARCHAR + CHECK), so
there is no PG ENUM type to create or drop here -- same convention the
``followed_collections``/``pending_imports`` migration (f7c2b0d41a95) used
for the same ``import_site`` values.

Revision ID: 1f5e65c814aa
Revises: 676fe0585c15
Create Date: 2026-07-11 17:29:57.112331

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1f5e65c814aa"
down_revision: str | Sequence[str] | None = "676fe0585c15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "remote_collection_cache",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column(
            "site",
            sa.Enum(
                "thingiverse",
                "printables",
                "makerworld",
                name="import_site",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("list_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=True),
        sa.Column("count", sa.Integer(), nullable=True),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site", "list_id", name="uq_remote_collection_cache_site_list"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("remote_collection_cache")
