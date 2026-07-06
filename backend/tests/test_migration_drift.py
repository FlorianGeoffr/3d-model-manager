"""Migration drift-guard (M1 final-review backlog item, folded into M2 Task
1 per the plan: "the task that owns the file"). Every future schema change
across every milestone risks the models and the Alembic migration(s) that
are supposed to produce them silently diverging -- Alembic autogenerate
against the REAL migrated test DB is the strongest possible check that they
still match exactly.

``alembic.autogenerate.compare_metadata`` returns an empty list when the
live DB schema (as built by applying every migration, see the ``migrated_db``
fixture) matches ``Base.metadata`` (every ``app.models`` class) exactly --
any non-empty result means a model changed without a matching migration, or
vice versa.

The plan flagged a risk that ``models.name``/``models.description``'s custom
pg_trgm GIN indexes (``postgresql_ops={"name": "gin_trgm_ops"}``) might
false-positive here if Alembic's reflection can't recover the trgm operator
class from the live index definition. Verified empirically against this
project's installed alembic/SQLAlchemy versions: it doesn't happen (the diff
below is genuinely empty, trgm indexes included) -- so no ``include_object``
filter is added. If a future dependency bump makes this test start failing
on exactly those two index names, that's where such a filter would go.
"""

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Base


def _compare_metadata(sync_conn: Connection) -> list[object]:
    context = MigrationContext.configure(sync_conn)
    return compare_metadata(context, Base.metadata)


async def test_models_match_migrations_exactly(db_session: AsyncSession) -> None:
    conn = await db_session.connection()
    diffs = await conn.run_sync(_compare_metadata)

    assert diffs == []
