"""add categories and models.print_count

R13b: `categories(id, name UNIQUE, color, created_at)` -- a single-valued,
exclusive grouping for models (distinct from `tags`, many-to-many), plus
`models.category_id` (FK ON DELETE SET NULL, indexed).

`models.print_count` (Risk resolution 4) denormalizes the count of `prints`
rows per model so the "Most printed" gallery sort can use the SAME
keyset-cursor path as `updated_at`/`name` -- a live `COUNT(*)` subquery
couldn't back a composite index. Backfilled from `prints` below; the single
writer going forward is `app.services.prints` (`create_print`/
`delete_print`), with `recount_print_counts`/`_sync` as the self-healing
backstop wired into the scan job.

`ix_models_created_at_id` backs the new "Recently added" (`-created_at`)
sort, same composite-index idiom as the existing `updated_at`/`name` ones.

Revision ID: 2490bc11a7f5
Revises: c1a2b3d4e5f6
Create Date: 2026-09-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2490bc11a7f5"
down_revision: str | Sequence[str] | None = "c1a2b3d4e5f6"
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
    op.create_table(
        "categories",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("color", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_categories_name"),
    )
    op.create_check_constraint(
        "ck_categories_color_palette",
        "categories",
        sa.or_(sa.column("color").in_(_PALETTE), sa.column("color").is_(None)),
    )

    op.add_column("models", sa.Column("category_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        "fk_models_category_id_categories",
        "models",
        "categories",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_models_category_id", "models", ["category_id"])

    op.add_column(
        "models",
        sa.Column("print_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        UPDATE models
        SET print_count = (SELECT count(*) FROM prints WHERE prints.model_id = models.id)
        """
    )
    op.create_index("ix_models_print_count_id", "models", ["print_count", "id"])
    op.create_index("ix_models_created_at_id", "models", ["created_at", "id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_models_created_at_id", table_name="models")
    op.drop_index("ix_models_print_count_id", table_name="models")
    op.drop_column("models", "print_count")

    op.drop_index("ix_models_category_id", table_name="models")
    op.drop_constraint("fk_models_category_id_categories", "models", type_="foreignkey")
    op.drop_column("models", "category_id")

    op.drop_constraint("ck_categories_color_palette", "categories", type_="check")
    op.drop_table("categories")
