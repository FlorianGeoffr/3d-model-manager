"""add followed_collections and pending_imports

M8 H: the remote lists (collections / likes) the user follows, each with its
own auto-vs-review sync mode, plus the review queue that a ``review`` list's
sync parks newly discovered items in.

Enums are ``native_enum=False`` per project convention (VARCHAR + CHECK), so
there is no PG ENUM type to create or drop here.

Revision ID: f7c2b0d41a95
Revises: e4f1a9c73b28
Create Date: 2026-07-09 10:35:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f7c2b0d41a95"
down_revision: str | Sequence[str] | None = "e4f1a9c73b28"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _import_site() -> sa.Enum:
    return sa.Enum(
        "thingiverse",
        "printables",
        "makerworld",
        name="import_site",
        native_enum=False,
        create_constraint=True,
    )


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "followed_collections",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("site", _import_site(), nullable=False),
        sa.Column("list_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "mode",
            sa.Enum(
                "auto",
                "review",
                name="collection_sync_mode",
                native_enum=False,
                create_constraint=True,
            ),
            nullable=False,
        ),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site", "list_id", name="uq_followed_collections_site_list"),
    )
    op.create_table(
        "pending_imports",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("collection_id", sa.BigInteger(), nullable=False),
        sa.Column("site", _import_site(), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["collection_id"], ["followed_collections.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "collection_id", "external_id", name="uq_pending_imports_collection_item"
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("pending_imports")
    op.drop_table("followed_collections")
