"""add webp blob format

Revision ID: c69140b3976b
Revises: 6c0061cee09b
Create Date: 2026-07-12 01:10:46.975078

feat/import-fidelity T1: ``BlobFormat`` gains ``WEBP`` (MakerWorld ships
``Auxiliaries/Model Pictures/*.webp`` inside its 3MF containers). ``blobs.
format`` is ``sa.Enum(..., native_enum=False, create_constraint=True)`` --
a plain VARCHAR plus a CHECK constraint (``app.models.base.str_enum``'s
docstring: "portable and easy to alter later without ALTER TYPE") -- so
extending it is just drop-and-recreate the CHECK constraint, no ``ALTER
TYPE`` / column-type change needed. Verified against the live schema
(``\\d blobs``): the constraint is named ``ck_blobs_blob_format`` and the
``format`` column is already ``varchar(9)`` (sized off ``"gcode_3mf"``,
the longest existing value) -- ``"webp"`` fits without widening it.
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c69140b3976b"
down_revision: str | Sequence[str] | None = "6c0061cee09b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# `op.f(...)` marks this as an ALREADY-final name -- without it, Alembic
# re-runs the app's own naming convention ("ck": "ck_%(table_name)s_
# %(constraint_name)s", app.models.base.NAMING_CONVENTION) over whatever
# string is passed, which would double-prefix an already-prefixed name into
# "ck_blobs_ck_blobs_blob_format" (caught by the backend test suite: every
# DB-touching test failed migrating with exactly that bogus constraint name).
_CONSTRAINT_NAME = op.f("ck_blobs_blob_format")
_OLD_FORMATS = ("stl", "3mf", "obj", "step", "iges", "gcode_3mf", "gcode", "png", "jpg", "other")
_NEW_FORMATS = (*_OLD_FORMATS[:-1], "webp", "other")


def _in_clause(values: tuple[str, ...]) -> str:
    return "format IN (" + ", ".join(f"'{v}'" for v in values) + ")"


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint(_CONSTRAINT_NAME, "blobs", type_="check")
    op.create_check_constraint(_CONSTRAINT_NAME, "blobs", _in_clause(_NEW_FORMATS))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(_CONSTRAINT_NAME, "blobs", type_="check")
    op.create_check_constraint(_CONSTRAINT_NAME, "blobs", _in_clause(_OLD_FORMATS))
