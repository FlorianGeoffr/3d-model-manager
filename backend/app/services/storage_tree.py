"""`GET /storage/tree` (R13b): one level of the canonical storage layout,
derived from `File.storage_path` prefixes (`<slug>/<rev-dir>/<rel_path>`,
see `app.services.layout.file_key`) -- no filesystem walk, so the tree's
depth is exactly what the layout is (root = model slugs, one level down =
revision directories, and so on).

At any given `path`, each immediate child segment is either:
- a **model**, when the child's full path exactly matches a `Model.slug`
  (only possible at the root, since slugs never contain `/`) -- surfaced as
  a `ModelSummary` instead of a plain directory, since descending further
  (into revisions/files) isn't a useful library-browsing unit; or
- a plain **dir** otherwise (e.g. a revision directory), with `count` = the
  number of files nested under it.

Internal snapshot files (`_snapshots/...`) are excluded everywhere, same as
every other user-facing file listing (`app.services.layout.is_snapshot_path`).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import Settings
from app.models.library import File, Model
from app.schemas.storage_tree import StorageTreeDirOut, StorageTreeOut
from app.services.library import _escape_like, build_model_summaries


async def get_storage_tree(db: AsyncSession, settings: Settings, path: str) -> StorageTreeOut:
    prefix = "" if not path else path.rstrip("/") + "/"

    stmt = select(File.storage_path)
    if prefix:
        stmt = stmt.where(File.storage_path.like(f"{_escape_like(prefix)}%", escape="\\"))
    storage_paths = (await db.execute(stmt)).scalars().all()

    child_counts: dict[str, int] = {}
    for storage_path in storage_paths:
        if "/_snapshots/" in storage_path:
            continue
        rest = storage_path[len(prefix) :]
        if not rest:
            continue
        name = rest.split("/", 1)[0]
        child_counts[name] = child_counts.get(name, 0) + 1

    full_paths = {name: f"{prefix}{name}" for name in child_counts}
    models_by_slug: dict[str, Model] = {}
    if full_paths:
        models_by_slug = {
            m.slug: m
            for m in (
                await db.execute(
                    select(Model)
                    .where(Model.slug.in_(full_paths.values()))
                    .options(selectinload(Model.tags), selectinload(Model.category))
                )
            ).scalars()
        }

    dirs: list[StorageTreeDirOut] = []
    model_rows: list[Model] = []
    for name, count in child_counts.items():
        model = models_by_slug.get(full_paths[name])
        if model is not None:
            model_rows.append(model)
        else:
            dirs.append(StorageTreeDirOut(name=name, count=count))

    dirs.sort(key=lambda d: d.name)
    model_rows.sort(key=lambda m: m.slug)
    models = await build_model_summaries(db, settings, model_rows)

    return StorageTreeOut(path=path, dirs=dirs, models=models)
