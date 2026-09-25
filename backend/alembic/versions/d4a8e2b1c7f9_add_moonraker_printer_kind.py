"""add moonraker printer kind

Revision ID: d4a8e2b1c7f9
Revises: f3a1c9d2e8b7
Create Date: 2026-09-20 22:00:00.000000

Adds "moonraker" to PrinterKind enum to support Klipper / Moonraker printers (e.g. Qidi Q2).
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4a8e2b1c7f9"
down_revision: str | Sequence[str] | None = "f3a1c9d2e8b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT_NAME = "ck_printers_printer_kind"
_OLD_KINDS = ("bambu_lan",)
_NEW_KINDS = ("bambu_lan", "moonraker")


def _in_clause(values: tuple[str, ...]) -> str:
    return "kind IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(op.f(_CONSTRAINT_NAME), "printers", type_="check")
    op.create_check_constraint(op.f(_CONSTRAINT_NAME), "printers", _in_clause(_NEW_KINDS))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(op.f(_CONSTRAINT_NAME), "printers", type_="check")
    op.create_check_constraint(op.f(_CONSTRAINT_NAME), "printers", _in_clause(_OLD_KINDS))
