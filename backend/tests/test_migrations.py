"""The baseline Alembic migration applies cleanly and produces the exact
schema surface SPEC "Data model" requires: every table, the pg_trgm
extension, and the explicitly-called-out indexes.

Applying the migration happens in the ``migrated_db``/``db_session``
fixtures (see conftest.py) -- if the migration itself is broken, every test
in this whole suite fails at fixture setup, which is the strongest possible
"the migration applies cleanly" signal. The assertions below additionally
pin down exactly what it must have created.
"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

EXPECTED_TABLES = {
    "users",
    "sessions",
    "models",
    "tags",
    "model_tags",
    "notes",
    "revisions",
    "blobs",
    "files",
    "blob_meta",
    "derivatives",
    "assembly_thumbs",
    "printers",
    "print_jobs",
    "imports",
    "jobs",
    "scan_runs",
    "settings",
}

EXPECTED_INDEXES = {
    "ix_files_blob_hash",
    "ix_files_storage_path",
    "ix_models_name_trgm",
    "ix_models_description_trgm",
    "ix_print_jobs_state",
    # Task 7 (D1): gallery keyset/filter indexes.
    "ix_models_name_id",
    "ix_models_updated_at_id",
    "ix_model_tags_tag_id",
    "ix_blobs_format",
    "ix_blob_meta_print_time_s",
}


async def test_migration_creates_every_spec_table(db_session: AsyncSession) -> None:
    result = await db_session.execute(
        text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    )
    tables = {row[0] for row in result}

    assert tables >= EXPECTED_TABLES


async def test_migration_installs_pg_trgm_extension(db_session: AsyncSession) -> None:
    result = await db_session.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"))

    assert result.scalar() == 1


async def test_migration_creates_spec_indexes(db_session: AsyncSession) -> None:
    result = await db_session.execute(
        text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
    )
    indexes = {row[0] for row in result}

    assert indexes >= EXPECTED_INDEXES


async def test_models_name_and_description_indexes_use_trgm_gin(db_session: AsyncSession) -> None:
    result = await db_session.execute(
        text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE schemaname = 'public' AND indexname IN "
            "('ix_models_name_trgm', 'ix_models_description_trgm')"
        )
    )
    defs = [row[0] for row in result]

    assert len(defs) == 2
    assert all("USING gin" in d and "gin_trgm_ops" in d for d in defs)
