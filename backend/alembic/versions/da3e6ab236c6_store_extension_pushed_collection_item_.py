"""store extension pushed collection item membership

M10 Workstream A task 3: ``remote_collection_items`` holds the extension-
pushed MEMBERSHIP of one remote collection -- which models belong to it, per
the last ``POST /ext/collections/{list_id}/items`` push. Exists because
``GET /api/v1/design-service/favorites/designs/{listId}`` (the endpoint
``app.importers.makerworld.MakerWorldImporter.list_list_items`` reads live)
serves ONLY the uid aggregate ("all collected models") from a server IP; a
real named collection id returns `200 {"total":0}` (live-verified
2026-07-11 against 3 real ids), so a followed named collection would
otherwise sync zero items forever. ``list_list_items`` falls back to this
table when the live fetch comes back empty for a non-uid list id.

Enums are ``native_enum=False`` per project convention (VARCHAR + CHECK), so
there is no PG ENUM type to create or drop here -- same convention
``remote_collection_cache`` (1f5e65c814aa) used for the same ``import_site``
values.

Revision ID: da3e6ab236c6
Revises: 1f5e65c814aa
Create Date: 2026-07-11 18:37:05.023046

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "da3e6ab236c6"
down_revision: str | Sequence[str] | None = "1f5e65c814aa"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "remote_collection_items",
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
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "site", "list_id", "external_id", name="uq_remote_collection_items_site_list_external"
        ),
    )
    op.create_index(
        "ix_remote_collection_items_site_list", "remote_collection_items", ["site", "list_id"]
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_remote_collection_items_site_list", table_name="remote_collection_items")
    op.drop_table("remote_collection_items")
