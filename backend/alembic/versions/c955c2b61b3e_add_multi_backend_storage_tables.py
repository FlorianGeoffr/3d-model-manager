"""add multi-backend storage tables

Revision ID: c955c2b61b3e
Revises: 9db520510a17
Create Date: 2026-07-08 21:06:54.198139

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import column, table

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c955c2b61b3e"
down_revision: str | Sequence[str] | None = "9db520510a17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "storage_backends",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("scheme", sa.Text(), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_storage_backends")),
    )
    # Enforces the single-default invariant: at most one row may have
    # `is_default = true` (any number may be `false`).
    op.create_index(
        "uq_storage_backends_is_default",
        "storage_backends",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )

    op.create_table(
        "file_locations",
        sa.Column("file_id", sa.BigInteger(), nullable=False),
        sa.Column("backend_id", sa.BigInteger(), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["backend_id"],
            ["storage_backends.id"],
            name=op.f("fk_file_locations_backend_id_storage_backends"),
        ),
        sa.ForeignKeyConstraint(
            ["file_id"],
            ["files.id"],
            name=op.f("fk_file_locations_file_id_files"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("file_id", "backend_id", name=op.f("pk_file_locations")),
    )
    op.create_index(
        op.f("ix_file_locations_backend_id"), "file_locations", ["backend_id"], unique=False
    )

    op.add_column("files", sa.Column("backend_id", sa.BigInteger(), nullable=True))
    op.create_index(op.f("ix_files_backend_id"), "files", ["backend_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_files_backend_id_storage_backends"),
        "files",
        "storage_backends",
        ["backend_id"],
        ["id"],
    )

    # --- Data seed: existing installs must keep working unattended. -------
    # Insert exactly ONE default `storage_backends` row -- copying the
    # legacy single-backend `settings.storage` row verbatim (it's already
    # Fernet-encrypted, so it's carried across as-is) when present, else a
    # fresh `LocalConfig()` (`{"backend": "local"}`) -- then point every
    # existing file at it (primary `backend_id` + a `file_locations` row).
    # All three statements are no-ops on a fresh, empty database: the
    # `settings` SELECT below just returns nothing, and an UPDATE/INSERT-
    # SELECT over zero `files` rows inserts/updates zero rows.
    settings_t = table("settings", column("key", sa.Text()), column("value", postgresql.JSONB()))
    backends_t = table(
        "storage_backends",
        column("id", sa.BigInteger()),
        column("name", sa.Text()),
        column("scheme", sa.Text()),
        column("config", postgresql.JSONB()),
        column("is_default", sa.Boolean()),
    )
    files_t = table(
        "files",
        column("id", sa.BigInteger()),
        column("backend_id", sa.BigInteger()),
        column("verified_at", sa.DateTime(timezone=True)),
    )
    file_locations_t = table(
        "file_locations",
        column("file_id", sa.BigInteger()),
        column("backend_id", sa.BigInteger()),
        column("verified_at", sa.DateTime(timezone=True)),
    )

    conn = op.get_bind()
    existing = conn.execute(
        sa.select(settings_t.c.value).where(settings_t.c.key == "storage")
    ).first()
    config = dict(existing[0]) if existing is not None else {"backend": "local"}
    scheme = config.get("backend", "local")

    default_id = conn.execute(
        sa.insert(backends_t)
        .values(name="Default", scheme=scheme, config=config, is_default=True)
        .returning(backends_t.c.id)
    ).scalar_one()

    conn.execute(sa.update(files_t).values(backend_id=default_id))
    conn.execute(
        sa.insert(file_locations_t).from_select(
            ["file_id", "backend_id", "verified_at"],
            sa.select(files_t.c.id, sa.literal(default_id), files_t.c.verified_at),
        )
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(
        op.f("fk_files_backend_id_storage_backends"), "files", type_="foreignkey"
    )
    op.drop_index(op.f("ix_files_backend_id"), table_name="files")
    op.drop_column("files", "backend_id")

    op.drop_index(op.f("ix_file_locations_backend_id"), table_name="file_locations")
    op.drop_table("file_locations")

    op.drop_index("uq_storage_backends_is_default", table_name="storage_backends")
    op.drop_table("storage_backends")
