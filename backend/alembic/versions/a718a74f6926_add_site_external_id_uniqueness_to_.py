"""add site+external_id uniqueness to pending_imports

Revision ID: a718a74f6926
Revises: c69140b3976b
Create Date: 2026-07-12 19:21:15.832992

R7 T1: item identity for dedup purposes has always been ``(site,
external_id)`` (``app.services.import_dedup``), but ``pending_imports`` was
only ever unique per ``(collection_id, external_id)`` -- so a sync that
discovered the same item through two different followed lists (e.g. the
MakerWorld aggregate "all collected models" and a specific named collection)
would queue it twice. ``app.services.collections.add_pending_sync``/
``drop_pending_sync`` now dedup/drop site-wide; this is the matching DB-level
backstop.

Live data already satisfies the new constraint (98 distinct external_ids
verified against the live ``pending_imports`` table before writing this
migration). Other instances may not be so lucky -- any DB that ran the old,
buggy ``add_pending_sync`` while following both an aggregate and a specific
named collection could have accumulated true ``(site, external_id)`` dupes,
which would make ``create_unique_constraint`` below raise. ``upgrade()``
therefore deletes duplicates (keeping the lowest id) before adding the
constraint; this is a no-op on an already-clean table such as this repo's.
The older ``(collection_id, external_id)`` constraint is left in place --
it's now implied-redundant but harmless.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a718a74f6926"
down_revision: str | Sequence[str] | None = "c69140b3976b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# `op.f(...)` marks this as an ALREADY-final name -- see c69140b3976b's
# module docstring for why omitting it would double-prefix into something
# like "uq_pending_imports_uq_pending_imports_site_external_id". It must be
# called inside upgrade()/downgrade(): at import time the Alembic operations
# proxy is not established yet, so `alembic heads`/`history` would raise.
_CONSTRAINT_NAME = "uq_pending_imports_site_external_id"


def upgrade() -> None:
    """Upgrade schema."""
    # Defensive pre-dedup: remove all but the lowest-id row per (site,
    # external_id) group so the constraint below can't fail on an instance
    # that accumulated dupes under the old, buggy sync. No-op if the table
    # is already clean.
    op.execute(
        "DELETE FROM pending_imports a USING pending_imports b "
        "WHERE a.site = b.site AND a.external_id = b.external_id AND a.id > b.id"
    )
    op.create_unique_constraint(op.f(_CONSTRAINT_NAME), "pending_imports", ["site", "external_id"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f(_CONSTRAINT_NAME), "pending_imports", type_="unique")
