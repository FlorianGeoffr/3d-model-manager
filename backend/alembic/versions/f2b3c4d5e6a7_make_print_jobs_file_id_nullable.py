"""make print_jobs file_id nullable and cleanup mismatched files

Revision ID: f2b3c4d5e6a7
Revises: e3d8f1a2b4c5
Create Date: 2026-10-03 17:35:00.000000

Makes print_jobs.file_id nullable so that external or out-of-band print jobs
detected on a printer do not have to be arbitrarily bound to the latest uploaded
file in the database.
Also cleans up existing print jobs where file_id was wrongly assigned by clearing
file_id where subtask_name does not match the file's path.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f2b3c4d5e6a7"
down_revision: str | Sequence[str] | None = "e3d8f1a2b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "print_jobs",
        "file_id",
        existing_type=sa.BigInteger(),
        nullable=True,
    )

    # Clean up existing corrupted print_jobs where subtask_name was set and does not
    # match the linked file. Exclude internal TDMM jobs (prefixed with 'tdmm-').
    op.execute(
        """
        UPDATE print_jobs
        SET file_id = NULL
        WHERE file_id IS NOT NULL
          AND subtask_name IS NOT NULL
          AND subtask_name NOT LIKE 'tdmm-%'
          AND NOT EXISTS (
              SELECT 1 FROM files
              WHERE files.id = print_jobs.file_id
                AND (
                    LOWER(files.rel_path) = LOWER(print_jobs.subtask_name)
                    OR print_jobs.subtask_name ILIKE ('%' || files.rel_path)
                    OR files.rel_path ILIKE ('%' || print_jobs.subtask_name)
                )
          )
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE print_jobs
        SET file_id = (SELECT id FROM files ORDER BY id DESC LIMIT 1)
        WHERE file_id IS NULL
        """
    )
    op.alter_column(
        "print_jobs",
        "file_id",
        existing_type=sa.BigInteger(),
        nullable=False,
    )
