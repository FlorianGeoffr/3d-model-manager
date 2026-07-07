"""The library scanner/reconciler (SPEC "Rescan/reconcile (`scan_library`)";
Task 5 brief).

**CRITICAL invariant (Global Constraints "SCANNER NEVER DELETES LIBRARY
FILES"):** this module only ever *reads* the backend (``walk``/``read``/
``stat``), touches ``verified_at``/``mtime``, repoints/inserts DB rows, and
marks files ``missing``. It NEVER calls ``backend.delete``/``backend.move``
on library content and NEVER deletes a ``files``/``models``/``revisions``
row. A DB path absent on disk is reported ``missing`` for a human to resolve
in the UI -- this module leaves it alone.

Runs entirely in the worker's SYNC world (see ``app.tasks.base``) -- callers
pass a plain SQLAlchemy ``Session``, never the API's async engine.

Reconcile algorithm (SPEC decision table, implemented exactly):

1. Snapshot ``{storage_path: File}`` (size comes from the joined ``Blob``).
2. ``backend.walk("")`` the tree, skipping ``.3dmm.json`` sidecars (handled
   separately below -- they aren't ``files`` rows).
3. Per on-disk entry:
   - **Known path, unchanged** (size matches, and on local/SMB mtime matches
     within tolerance; S3 compares size only): touch ``verified_at``, count
     toward ``report["verified"]``. No re-hash.
   - **Known path, changed**: re-hash. Same hash -> just refresh
     ``mtime``/``verified_at``. New hash -> upsert the ``Blob``, repoint
     ``file.blob_hash``, append to ``report["changed"]``, best-effort
     re-enqueue the pipeline.
   - **Unknown path**: re-hash. Known hash with a matching missing-candidate
     (same hash + matching ``rel_path`` tail) -> relink (repoint
     ``storage_path``). Known hash with no candidate, or unknown hash ->
     adopt (attach to an existing model+revision if the key fits
     ``<slug>/<dir_name>/<rel...>``, else create a draft ``Model`` +
     ``rev-001`` flagged ``review_state="adopted"``).
4. Any snapshot file never matched by an on-disk entry -> ``missing``. Its
   row and the (absent) object are both left untouched.
5. Counters + the report JSONB are written onto the ``ScanRun`` row, which is
   marked ``state="done"``.

Implementation decisions not spelled out verbatim by the SPEC table (documented
here rather than guessed silently, per the task's "stop on genuine ambiguity"
instruction -- none of these affect data-integrity, only report/adoption
bookkeeping for corner cases the table doesn't enumerate):

- ``report["verified"]`` is only bumped by the cheap size/mtime match (SPEC
  text literally scopes it to the "unchanged" row); a re-hash that lands back
  on the SAME hash (the "changed" row's first branch) updates ``mtime``/
  ``verified_at`` but isn't separately counted anywhere.
- The "adopted duplicate" branch (known hash, no relink candidate) and the
  "unknown hash" adopt branch share one attach-or-create-draft helper: SPEC
  spells out the fits-existing-model/else-create-draft split only for the
  unknown-hash case, but the same fallback is the only sane behavior for a
  duplicate that also doesn't fit anywhere.
- If attaching an adopted file would collide with an existing
  ``(revision_id, rel_path)`` row (a pre-existing DB inconsistency), it falls
  through to the create-draft-model branch instead of raising -- a single
  odd file must never abort the whole scan.
- The scanner also refreshes stale ``.3dmm.json`` sidecars it encounters
  (Global Constraints carried item: sidecars could go stale before Task 5's
  ``patch_model`` fix started keeping them in sync going forward) -- read
  back, compared against the model's current authoritative content, and
  rewritten only if they differ.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import PurePosixPath

from blake3 import blake3
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.config import Settings
from app.models import Blob, File, Model, Revision, ScanRun
from app.services import layout
from app.storage.base import EntryInfo, StorageBackend
from app.storage.s3 import S3StorageBackend

logger = logging.getLogger(__name__)

# How close local/SMB's on-disk mtime must be to the last-known `File.mtime`
# to count as "unchanged" without a re-hash -- absorbs filesystem timestamp
# rounding, not a meaningful window for anything else.
_MTIME_TOLERANCE_S = 2.0


def mark_scan_state(session: Session, scan_run_id: int, state: str) -> None:
    """Transition a ``ScanRun``'s ``state`` (Celery task bookkeeping, called
    before/around ``run_scan`` -- ``run_scan`` itself sets the terminal
    ``"done"`` state as the last step of a successful pass).
    """
    scan_run = session.get(ScanRun, scan_run_id)
    if scan_run is None:
        raise LookupError(f"scan run {scan_run_id} not found")
    scan_run.state = state
    if state in ("failed", "skipped"):
        scan_run.finished_at = datetime.now(UTC)
    session.commit()


def run_scan(
    session: Session, settings: Settings, backend: StorageBackend, scan_run_id: int
) -> None:
    """The whole reconcile pass against ``scan_run_id`` (must already exist,
    created by the caller). Synchronous end to end.
    """
    scan_run = session.get(ScanRun, scan_run_id)
    if scan_run is None:
        raise LookupError(f"scan run {scan_run_id} not found")

    now = datetime.now(UTC)
    size_only = isinstance(backend, S3StorageBackend)

    files_by_path: dict[str, File] = {
        f.storage_path: f
        for f in session.execute(select(File).options(joinedload(File.blob))).unique().scalars()
    }
    matched_file_ids: set[int] = set()
    # Relink candidates: files not yet matched to an on-disk entry. Consumed
    # (popped) as relinks claim them so the same origin row is never
    # relinked twice within one scan.
    unmatched_candidates: dict[int, File] = {f.id: f for f in files_by_path.values()}

    counters = {"files_seen": 0, "files_hashed": 0, "relinked": 0, "adopted": 0}
    report: dict[str, object] = {
        "adopted": [],
        "relinked": [],
        "changed": [],
        "missing": [],
        "verified": 0,
    }
    adopted_index: dict[tuple[int, int], dict] = {}
    # Top-level on-disk directory name -> the draft (Model, Revision) created
    # for it THIS scan, so multiple adopted files under the same dropped
    # folder land on one new model, not one model per file.
    draft_models: dict[str, tuple[Model, Revision]] = {}

    for entry in backend.walk(""):
        parts = entry.key.split("/")
        if len(parts) == 2 and parts[1] == layout.SIDECAR_NAME:
            _maybe_refresh_sidecar(session, backend, entry.key, parts[0])
            continue

        counters["files_seen"] += 1

        file = files_by_path.get(entry.key)
        if file is not None:
            _reconcile_known(session, backend, file, entry, size_only, now, counters, report)
            matched_file_ids.add(file.id)
            unmatched_candidates.pop(file.id, None)
            continue

        _reconcile_unknown(
            session,
            backend,
            entry,
            unmatched_candidates,
            matched_file_ids,
            draft_models,
            adopted_index,
            now,
            counters,
            report,
        )

    missing_files = [f for f in files_by_path.values() if f.id not in matched_file_ids]
    slug_by_file_id = _slugs_for_files(session, [f.id for f in missing_files])
    for file in missing_files:
        report["missing"].append(
            {
                "file_id": file.id,
                "storage_path": file.storage_path,
                "model_slug": slug_by_file_id.get(file.id, "?"),
            }
        )

    scan_run.files_seen = counters["files_seen"]
    scan_run.files_hashed = counters["files_hashed"]
    scan_run.relinked = counters["relinked"]
    scan_run.adopted = counters["adopted"]
    scan_run.missing = len(missing_files)
    scan_run.report = report
    scan_run.state = "done"
    scan_run.finished_at = datetime.now(UTC)
    session.commit()


def _slugs_for_files(session: Session, file_ids: list[int]) -> dict[int, str]:
    if not file_ids:
        return {}
    rows = session.execute(
        select(File.id, Model.slug)
        .join(Revision, Revision.id == File.revision_id)
        .join(Model, Model.id == Revision.model_id)
        .where(File.id.in_(file_ids))
    ).all()
    return dict(rows)


def _hash_entry(backend: StorageBackend, key: str) -> str:
    hasher = blake3()
    for chunk in backend.read(key):
        hasher.update(chunk)
    return hasher.hexdigest()


def _reconcile_known(
    session: Session,
    backend: StorageBackend,
    file: File,
    entry: EntryInfo,
    size_only: bool,
    now: datetime,
    counters: dict[str, int],
    report: dict[str, object],
) -> None:
    blob = file.blob
    unchanged = entry.size == blob.size and (
        size_only
        or (
            file.mtime is not None
            and abs((entry.mtime - file.mtime).total_seconds()) <= _MTIME_TOLERANCE_S
        )
    )
    if unchanged:
        file.verified_at = now
        report["verified"] += 1
        return

    counters["files_hashed"] += 1
    new_hash = _hash_entry(backend, entry.key)
    if new_hash == file.blob_hash:
        file.mtime = entry.mtime
        file.verified_at = now
        return

    old_hash = file.blob_hash
    new_blob = session.get(Blob, new_hash)
    if new_blob is None:
        kind, format_ = layout.infer_blob_kind_format(file.rel_path)
        new_blob = Blob(hash=new_hash, size=entry.size, kind=kind, format=format_)
        session.add(new_blob)
        session.flush()

    file.blob_hash = new_hash
    file.mtime = entry.mtime
    file.verified_at = now
    report["changed"].append(
        {
            "file_id": file.id,
            "storage_path": entry.key,
            "old_hash": old_hash,
            "new_hash": new_hash,
        }
    )
    _best_effort_pipeline(session, blob_hash=new_hash, file_id=file.id)


def _find_relink_candidate(candidates: dict[int, File], digest: str, key: str) -> File | None:
    matches = sorted(
        (
            f
            for f in candidates.values()
            if f.blob_hash == digest and (key == f.rel_path or key.endswith("/" + f.rel_path))
        ),
        key=lambda f: f.id,
    )
    return matches[0] if matches else None


def _rel_path_taken(session: Session, revision_id: int, rel_path: str) -> bool:
    return (
        session.scalar(
            select(File.id).where(File.revision_id == revision_id, File.rel_path == rel_path)
        )
        is not None
    )


def _unique_slug_sync(session: Session, name: str) -> str:
    base = layout.slug_for(name)
    slug = base
    suffix = 2
    while session.scalar(select(Model.id).where(Model.slug == slug)) is not None:
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def _resolve_adopt_target(
    session: Session,
    backend: StorageBackend,
    key: str,
    draft_models: dict[str, tuple[Model, Revision]],
) -> tuple[Model, Revision, str]:
    """Where an adopted ``key`` should attach: an existing model+revision if
    it fits ``<slug>/<dir_name>/<rel...>``, otherwise a draft model (reusing
    one already created this scan for the same top-level directory).
    """
    parts = key.split("/")
    if len(parts) >= 3:
        slug, dir_name, rel_path = parts[0], parts[1], "/".join(parts[2:])
        model = session.execute(select(Model).where(Model.slug == slug)).scalar_one_or_none()
        if model is not None:
            revision = session.execute(
                select(Revision).where(Revision.model_id == model.id, Revision.dir_name == dir_name)
            ).scalar_one_or_none()
            if revision is not None and not _rel_path_taken(session, revision.id, rel_path):
                return model, revision, rel_path

    top = parts[0] if len(parts) > 1 else PurePosixPath(parts[0]).stem
    rel_path = "/".join(parts[1:]) if len(parts) > 1 else parts[0]

    if top in draft_models:
        model, revision = draft_models[top]
        return model, revision, rel_path

    slug = _unique_slug_sync(session, top)
    model = Model(slug=slug, name=top, review_state="adopted")
    session.add(model)
    session.flush()
    dir_name = layout.revision_dir_name(1, "initial")
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name=dir_name)
    session.add(revision)
    session.flush()
    model.current_revision_id = revision.id
    layout.write_sidecar(backend, model.id, slug, top)
    draft_models[top] = (model, revision)
    return model, revision, rel_path


def _record_adopted(
    report: dict[str, object],
    adopted_index: dict[tuple[int, int], dict],
    model: Model,
    revision: Revision,
    rel_path: str,
) -> None:
    key = (model.id, revision.id)
    entry = adopted_index.get(key)
    if entry is None:
        entry = {"model_id": model.id, "slug": model.slug, "revision_id": revision.id, "files": []}
        adopted_index[key] = entry
        report["adopted"].append(entry)
    entry["files"].append(rel_path)


def _attach_adopted_file(
    session: Session,
    backend: StorageBackend,
    entry: EntryInfo,
    blob: Blob,
    draft_models: dict[str, tuple[Model, Revision]],
    adopted_index: dict[tuple[int, int], dict],
    now: datetime,
    counters: dict[str, int],
    report: dict[str, object],
    *,
    enqueue_pipeline: bool,
) -> None:
    model, revision, rel_path = _resolve_adopt_target(session, backend, entry.key, draft_models)

    file = File(
        revision_id=revision.id,
        blob_hash=blob.hash,
        rel_path=rel_path,
        storage_path=entry.key,
        mtime=entry.mtime,
        verified_at=now,
    )
    session.add(file)
    session.flush()

    counters["adopted"] += 1
    _record_adopted(report, adopted_index, model, revision, rel_path)
    if enqueue_pipeline:
        _best_effort_pipeline(session, blob_hash=blob.hash, file_id=file.id)


def _reconcile_unknown(
    session: Session,
    backend: StorageBackend,
    entry: EntryInfo,
    unmatched_candidates: dict[int, File],
    matched_file_ids: set[int],
    draft_models: dict[str, tuple[Model, Revision]],
    adopted_index: dict[tuple[int, int], dict],
    now: datetime,
    counters: dict[str, int],
    report: dict[str, object],
) -> None:
    counters["files_hashed"] += 1
    digest = _hash_entry(backend, entry.key)
    blob = session.get(Blob, digest)

    if blob is not None:
        candidate = _find_relink_candidate(unmatched_candidates, digest, entry.key)
        if candidate is not None:
            old_path = candidate.storage_path
            candidate.storage_path = entry.key
            candidate.mtime = entry.mtime
            candidate.verified_at = now
            counters["relinked"] += 1
            report["relinked"].append(
                {"file_id": candidate.id, "from": old_path, "to": entry.key, "hash": digest}
            )
            matched_file_ids.add(candidate.id)
            unmatched_candidates.pop(candidate.id, None)
            return

        _attach_adopted_file(
            session,
            backend,
            entry,
            blob,
            draft_models,
            adopted_index,
            now,
            counters,
            report,
            enqueue_pipeline=False,
        )
        return

    kind, format_ = layout.infer_blob_kind_format(entry.key)
    new_blob = Blob(hash=digest, size=entry.size, kind=kind, format=format_)
    session.add(new_blob)
    session.flush()
    _attach_adopted_file(
        session,
        backend,
        entry,
        new_blob,
        draft_models,
        adopted_index,
        now,
        counters,
        report,
        enqueue_pipeline=True,
    )


def _best_effort_pipeline(session: Session, *, blob_hash: str, file_id: int) -> None:
    """Best-effort pipeline dispatch (Task 5 brief: "swallowing dispatch
    errors -- a scan covers many files"). ``app.tasks.pipeline`` is imported
    locally to avoid a module-level import cycle (mirrors
    ``app.services.library``'s same-reasoning local imports of
    ``app.tasks.pipeline``).
    """
    from app.tasks.pipeline import start_pipeline_sync

    try:
        start_pipeline_sync(session, blob_hash=blob_hash, file_id=file_id)
    except Exception:
        logger.warning(
            "scan: pipeline dispatch failed for blob %s (file %s)",
            blob_hash,
            file_id,
            exc_info=True,
        )


def _maybe_refresh_sidecar(session: Session, backend: StorageBackend, key: str, slug: str) -> None:
    model = session.execute(select(Model).where(Model.slug == slug)).scalar_one_or_none()
    if model is None:
        return
    expected = layout.sidecar_content(model.id, model.slug, model.name)
    try:
        current = json.loads(b"".join(backend.read(key)))
    except Exception:
        current = None
    if current != expected:
        layout.write_sidecar(backend, model.id, model.slug, model.name)
