# M3 Implementation Plan — Pluggable Storage (SMB + S3) + Library Scanner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the library at an SMB share or an S3 bucket (not just local disk), configure/test/migrate the backend from a Settings UI, and run a `scan_library` reconciler that adopts out-of-band folders and relinks moved folders by hash — surfaced in a scan-report UI — while the container can drop to a configured PUID/PGID.

**Architecture:** Three backends (`local`, `smb`, `s3`) all satisfy the *existing* `app.storage.base.StorageBackend` protocol (already implemented for `local`; M3 adds `smb`/`s3` — no protocol change). The active backend is chosen from a DB-backed `settings` row validated by per-backend pydantic models; a resolver reads that row in both the async (API) and sync (Celery) worlds, so adding a fourth backend later is one module + one `@register` line with zero changes to ingest, revisions, the pipeline, or the scanner. A single parameterized storage-contract test suite proves all three backends have identical semantics against dockerized Samba + MinIO. The `scan_library` Celery job walks the tree, reconciles it against `files`/`blobs` by hash (never by folder shape), and writes a `scan_runs` report.

**Tech Stack:** `smbprotocol>=1.16.1` (high-level `smbclient` API) · `boto3` · pydantic-settings/pydantic v2 discriminated unions · Celery (existing) · Redis singleton lock · testcontainers (Postgres/Redis existing + MinIO + a `dperson/samba` generic container) · React + TanStack Router/Query + shadcn (existing web stack) · `gosu` for privilege drop.

Executes milestone **M3** of `docs/superpowers/specs/2026-07-04-3d-model-manager-design.md` (SPEC). Read the SPEC sections "Storage layer", "Path layout", "Rescan/reconcile (`scan_library`)", "API surface", "Frontend", "Verification", and the milestone line "M3 — Pluggable storage + scanner" before implementing. `docs/research/research-storage.md` (RESEARCH) carries the fsspec-rejection rationale and the exact per-backend atomic-write / fast-copy patterns.

## Global Constraints (bind every task)

- **Git identity:** commits authored by the repo-local git config (`metril <1517921+metril@users.noreply.github.com>`). NEVER add `Co-Authored-By`, "Generated with", or any AI-attribution lines.
- **Branch:** all M3 work on `feat/m3-storage-scanner` (branch from `main` at `a9e5743`).
- **Quality gates:** backend `uv run ruff check .` + `uv run ruff format --check .` clean, `uv run pytest` green with pristine output (no stray warnings/log noise in the summary); web `npm run build` (tsc strict) green, `npm run lint` clean, `npm test` green. TDD required for every backend logic task: failing test first, RED/GREEN evidence in the task report.
- **Real infra in tests (hard rule, unchanged from M1/M2):** PostgreSQL + Redis via testcontainers; Celery eager (existing autouse fixture). M3 adds real MinIO (S3) and a real `dperson/samba` container (SMB) via testcontainers — never `moto`, never a mock SMB. Never SQLite, never fakeredis. Mocks only at the edges (e.g. monkeypatching a backend method to inject a mid-write failure), per M1/M2 convention. Backends run for real against their containers.
- **The storage protocol is frozen:** `app/storage/base.py` (`write`/`read`/`copy`/`move`/`delete`/`exists`/`stat`/`walk`/`mkdirs` + `WriteResult`/`EntryInfo`/`StatResult`) does NOT change in M3. SMB/S3 implement the same signatures and semantics, including the subtle `walk()` ordering contract ("sort each directory's entries by bare name, recurse depth-first" — NOT a total lexicographic sort over full keys) and the two typed errors (`StorageError`, `StorageKeyNotFound`). SMB/S3 translate their native not-found errors (SMB `STATUS_OBJECT_NAME_NOT_FOUND`, S3 404/`NoSuchKey`) into `StorageKeyNotFound`; nothing downstream catches backend-specific exceptions.
- **Backend selection is DB-driven:** the active backend + its connection config live in the existing `settings(key PK, value jsonb)` table under key `"storage"`, validated per-backend by pydantic models. `get_backend`/the resolver default to `local` (rooted at `TDMM_LIBRARY_ROOT`) when the row is absent — so a fresh install behaves exactly as M1/M2. Connection secrets NEVER come from new `TDMM_*` env vars.
- **SCANNER NEVER DELETES LIBRARY FILES (CRITICAL):** `scan_library` only ever *reads* the backend (`walk`/`read`/`stat`), touches `verified_at`, repoints/inserts DB rows, and marks `missing`. It NEVER calls `backend.delete`/`backend.move` on library content and NEVER deletes a `files`/`models`/`revisions` row. A DB path absent on disk is reported `missing` for the human to resolve in the UI — the scanner leaves it. Any code path in a scanner task that mutates the backend is a defect.
- **DERIVATIVES ALWAYS STAY LOCAL (CRITICAL):** thumbnails/GLB/plate PNGs/assembly thumbs live under `{settings.data_dir}/derivatives/...` on local disk regardless of the active library backend. The `StorageBackend` abstraction is for the *library tree only*. `services/derivatives.py` keeps using plain `pathlib`/`os` for the derivative store; only its `fetch_blob_to_temp` (which *reads* a library original) goes through the active backend. Migrating the library to SMB/S3 does NOT migrate derivatives.
- **Originals are immutable to the pipeline:** unchanged from M2 — pipeline steps read library bytes via the active backend's `read`, never write the library. The scanner is the same: read-only against library content.
- **Atomic-write + fast-copy per backend (RESEARCH §5 / SPEC "Storage layer" table):**
  | Backend | Atomic write | Fast copy | Walk |
  |---|---|---|---|
  | `local` (exists) | temp + `os.replace` same dir | FICLONE reflink → `shutil` fallback | `os.scandir` recursive |
  | `smb` (Task 3) | UUID temp + `smbclient.replace()` | `smbclient.copyfile()` → SMB2 COPYCHUNK (1.16.1 auto client-side fallback) | `smbclient.scandir()` using `SMBDirEntry.smb_info` — NO per-entry `stat` (no N+1) |
  | `s3` (Task 4) | none needed — PUT/CompleteMPU is all-or-nothing; write directly to the final key; DB commit is the txn boundary; a bucket lifecycle rule expires incomplete MPUs (documented, not created by us) | `CopyObject` (all our files ≤5 GB) | `list_objects_v2` paginator |
- **S3 ETags are NOT content hashes:** the scanner compares **size only** on S3 (never ETag) to decide "probably unchanged"; local/SMB compare size+mtime. Identity is ALWAYS the blake3 hash after a re-read, never the ETag.
- **SMB fork-safety:** smbprotocol sessions are registered **lazily per worker process on first use** (never at import time — Celery prefork forks workers; a session opened in the parent is unusable in a child). `smbclient.reset_connection_cache()` on worker shutdown. NAS addressed by IP or real DNS (`extra_hosts:` in compose); NTLM over SMB3 encryption (smbprotocol default), no Kerberos.
- **Version floors / deps:** `smbprotocol>=1.16.1` (the release that added `SMBDirEntry.smb_info` and COPYCHUNK client-side fallback), `boto3` (pin the resolved `boto3`+`botocore` pair via `uv lock`), dev extras `testcontainers[minio]`; also pin `testcontainers[redis]` explicitly (M2 backlog: used in conftest but never declared). No `s3fs`/`aiobotocore`/`fsspec`/`moto` — RESEARCH §1 rejects them (sync-only SMB with N+1 stats, aiobotocore↔boto3 pin conflict).
- **New endpoint verbs/paths (SPEC leaves these to M3 — this plan fixes them):** `POST /api/scan` (trigger), `GET /api/scan-runs` + `GET /api/scan-runs/{id}` (report), `GET/PUT /api/settings/storage` (read/set active backend config, secrets redacted on read), `POST /api/settings/storage/test` (connection test on a candidate config), `POST /api/settings/storage/migrate` (enqueue copy+verify+cutover job). All under the auth-gated `protected_router`.
- **Optional scheduled scan (SPEC: "optional scheduled scan"):** implemented as an opt-in Celery beat entry gated on a config value; OFF by default. Shipped in Task 5 (schedule wiring) + Task 9 (optional compose `beat` service). Not required for any acceptance criterion.
- **Test conventions (unchanged):** DB tests against the real Postgres testcontainer; storage-backend contract tests instantiate the concrete backend directly against its container (not through the FastAPI dependency); `tests/test_migration_drift.py` must stay green — any new model column lands with a matching Alembic migration; `-m 'not e2e'` keeps the unit gate off the live stack; e2e lives in `backend/tests_e2e/` run by `scripts/e2e.sh`.
- **M2-minor + carried-backlog triage (dispositions binding this milestone):**
  - **M2-Minor 1** ViewerTab has no error boundary → **fix in Task 8** (frontend).
  - **M2-Minor 2** `run_step`'s `session.get(Blob, blob_hash)` unchecked for `None` → **fix in Task 1** (Task 1 already edits `pipeline.py`'s backend-resolution site).
  - **M2-Minor 3** `convert.py` collapses multi-body STEP assemblies (loses part colors) → **wontfix in M3**: viewer-fidelity item in the M2 pipeline, unrelated to storage/scanner; defer to a future pipeline milestone.
  - **M2-Minor 4** `blobs.py` raw-500 on missing derivative file + single-value `If-None-Match` → **fix in Task 6** (Task 6 is the backend-API task; small hardening to a clean 404 + multi-value/`W/` ETag handling).
  - **M2-Minor 5** UploadPage `seenTerminal` grows unbounded → **fix in Task 8** (evict on terminal).
  - **M2-Minor 6** `has_sliced`/`print_time_s` include plain `.gcode` → **wontfix (confirmed intended)**: the gcode-header parser legitimately sets `print_time_s`; behavior is internally consistent, only the plan phrasing said "sliced" — documented as intended, no code change.
  - **Carried: PUID/PGID root containers** → **fix in Task 9**.
  - **Carried: `.3dmm.json` sidecar stale after PATCH name (annotated "M3 scanner note")** → **fix in Task 5**: `patch_model` rewrites the sidecar on name change, and the scanner refreshes stale sidecars during reconcile.
  - **Carried: `testcontainers[redis]` not pinned** → **fix in Task 1** (deps).
  - **Carried M1-era minors not intersecting M3 files** (expired-session cleanup, dual-redirect unification, `client.ts` docstring, `copyfileobj` 64KiB→1MiB, shadcn runtime dep + 607 KB bundle, note_count eager-fetch, shared `isPending`, Content-Disposition RFC5987, IntegrityError→409 mapping, upload size limit, replace-UI) → **defer (wontfix in M3)**: none are storage/scanner/settings work; folding them here would inflate an already-large milestone. They remain on the ledger. (Bundle weight: Task 7/8 add two pages — note the `npm run build` size delta in the Task 8 report so the ledger stays honest, but do not undertake the radix/shadcn de-bloat here.)
  - **Carried: `corpus_real/` still empty** → ask the user for 1–2 real Bambu exports at milestone close (standing request; not blocking).

---

## Task 1: Deps + DB-backed storage-config seam (pydantic models, resolver, rewired call sites)

SPEC "Storage layer" ("config validated per-backend via pydantic models in `settings`"; registry docstring's "M3 … `get_backend` will read the active scheme/config from the DB"). This task adds NO new backend — it builds the seam SMB/S3 plug into, so "adding a backend later = one module + one registry entry, no core changes" is literally true by the end of Task 4.

**Files:**
- Create: `backend/app/storage/config.py`, `backend/app/services/storage_config.py`, `backend/tests/test_storage_config.py`
- Modify: `backend/pyproject.toml`, `backend/app/storage/registry.py`, `backend/app/api/deps.py`, `backend/app/tasks/ingest.py`, `backend/app/tasks/pipeline.py`, `backend/tests/test_storage_registry.py`
- (No migration: the `settings` table already exists from the baseline.)

**Interfaces (Tasks 2–9 depend on these — keep names exact):**
- `app/storage/config.py`:
  ```python
  from typing import Annotated, Literal
  from pydantic import BaseModel, Field, TypeAdapter

  class LocalConfig(BaseModel):
      backend: Literal["local"] = "local"

  class SmbConfig(BaseModel):
      backend: Literal["smb"] = "smb"
      host: str                      # IP or real DNS name (see Global Constraints)
      share: str                     # SMB share name
      root: str = ""                 # POSIX subpath within the share used as the library root ("" = share root)
      username: str
      password: str
      port: int = 445
      encrypt: bool = True           # SMB3 encryption (smbprotocol default)

  class S3Config(BaseModel):
      backend: Literal["s3"] = "s3"
      bucket: str
      access_key: str
      secret_key: str
      endpoint_url: str | None = None      # None = real AWS; set for MinIO/other
      region: str | None = None
      prefix: str = ""                     # key prefix used as the library root ("" = bucket root)
      addressing: Literal["path", "virtual"] = "path"   # MinIO needs "path"

  StorageConfig = Annotated[LocalConfig | SmbConfig | S3Config, Field(discriminator="backend")]
  _ADAPTER = TypeAdapter(StorageConfig)

  def parse_storage_config(data: dict) -> StorageConfig:
      """Validate a raw settings-row dict into the right per-backend model."""
      return _ADAPTER.validate_python(data)

  def redacted(config: StorageConfig) -> dict:
      """JSON dict with secret fields masked, for GET responses."""
      data = config.model_dump()
      if isinstance(config, SmbConfig):
          data["password"] = "***" if config.password else ""
      if isinstance(config, S3Config):
          data["secret_key"] = "***" if config.secret_key else ""
      return data
  ```
- `app/storage/registry.py` — factory signature becomes config-aware:
  ```python
  _BackendFactory = Callable[[Settings, StorageConfig], StorageBackend]

  def get_backend(settings: Settings, config: StorageConfig | None = None) -> StorageBackend:
      """Return the backend for ``config`` (defaults to LocalConfig())."""
  ```
  Lookup key is `config.backend`. `config=None` → `LocalConfig()` (preserves every existing `get_backend(settings)` caller's behavior).
- `app/services/storage_config.py`:
  ```python
  SETTINGS_KEY = "storage"
  async def get_active_config(db: AsyncSession) -> StorageConfig            # LocalConfig() when row absent
  def get_active_config_sync(session: Session) -> StorageConfig
  async def set_active_config(db: AsyncSession, config: StorageConfig) -> None   # upsert the settings row (raw model_dump, secrets included — this is the source of truth)
  def set_active_config_sync(session: Session, config: StorageConfig) -> None
  async def resolve_backend(db: AsyncSession, settings: Settings) -> StorageBackend
  def resolve_backend_sync(session: Session, settings: Settings) -> StorageBackend
  ```

- [ ] **Step 1 — deps.** In `backend/pyproject.toml` add to `[project] dependencies`: `"smbprotocol>=1.16.1"`, `"boto3"`. In `[dependency-groups] dev` change `"testcontainers[postgres]"` → `"testcontainers[postgres,redis,minio]"`. Run `uv lock && uv sync`. Verify: `uv run python -c "import smbprotocol, smbclient, boto3; print('ok')"`.

- [ ] **Step 2 — write the config module** `app/storage/config.py` exactly as the interface block above.

- [ ] **Step 3 — failing test for the config service.** In `backend/tests/test_storage_config.py`:
  ```python
  import pytest
  from app.storage.config import LocalConfig, SmbConfig, S3Config, parse_storage_config, redacted
  from app.services.storage_config import (
      get_active_config, set_active_config, resolve_backend, SETTINGS_KEY,
  )
  from app.config import get_settings
  from app.storage.local import LocalStorageBackend

  def test_parse_discriminates_by_backend():
      assert isinstance(parse_storage_config({"backend": "local"}), LocalConfig)
      smb = parse_storage_config({"backend": "smb", "host": "h", "share": "s",
                                  "username": "u", "password": "p"})
      assert isinstance(smb, SmbConfig) and smb.port == 445 and smb.encrypt is True

  def test_redacted_masks_secrets():
      cfg = S3Config(bucket="b", access_key="AK", secret_key="SEKRIT")
      assert redacted(cfg)["secret_key"] == "***"
      assert redacted(cfg)["access_key"] == "AK"

  @pytest.mark.usefixtures("library_root")
  async def test_active_config_defaults_to_local_when_absent(db_session):
      cfg = await get_active_config(db_session)
      assert isinstance(cfg, LocalConfig)

  @pytest.mark.usefixtures("library_root")
  async def test_set_then_get_round_trips(db_session):
      await set_active_config(db_session, S3Config(bucket="b", access_key="AK", secret_key="SK"))
      cfg = await get_active_config(db_session)
      assert isinstance(cfg, S3Config) and cfg.bucket == "b" and cfg.secret_key == "SK"

  @pytest.mark.usefixtures("library_root")
  async def test_resolve_backend_defaults_to_local(db_session):
      backend = await resolve_backend(db_session, get_settings())
      assert isinstance(backend, LocalStorageBackend)
  ```
  Run: `uv run pytest tests/test_storage_config.py -v` → RED (module `app.services.storage_config` not found).

- [ ] **Step 4 — implement the config service** `app/services/storage_config.py`:
  ```python
  from sqlalchemy import select
  from sqlalchemy.ext.asyncio import AsyncSession
  from sqlalchemy.orm import Session

  from app.config import Settings
  from app.models import Setting
  from app.storage.base import StorageBackend
  from app.storage.config import LocalConfig, StorageConfig, parse_storage_config
  from app.storage.registry import get_backend

  SETTINGS_KEY = "storage"

  async def get_active_config(db: AsyncSession) -> StorageConfig:
      row = await db.get(Setting, SETTINGS_KEY)
      return LocalConfig() if row is None else parse_storage_config(row.value)

  def get_active_config_sync(session: Session) -> StorageConfig:
      row = session.get(Setting, SETTINGS_KEY)
      return LocalConfig() if row is None else parse_storage_config(row.value)

  async def set_active_config(db: AsyncSession, config: StorageConfig) -> None:
      row = await db.get(Setting, SETTINGS_KEY)
      if row is None:
          db.add(Setting(key=SETTINGS_KEY, value=config.model_dump()))
      else:
          row.value = config.model_dump()
      await db.commit()

  def set_active_config_sync(session: Session, config: StorageConfig) -> None:
      row = session.get(Setting, SETTINGS_KEY)
      if row is None:
          session.add(Setting(key=SETTINGS_KEY, value=config.model_dump()))
      else:
          row.value = config.model_dump()
      session.commit()

  async def resolve_backend(db: AsyncSession, settings: Settings) -> StorageBackend:
      return get_backend(settings, await get_active_config(db))

  def resolve_backend_sync(session: Session, settings: Settings) -> StorageBackend:
      return get_backend(settings, get_active_config_sync(session))
  ```

- [ ] **Step 5 — update the registry** `app/storage/registry.py`: change `_BackendFactory` to `Callable[[Settings, StorageConfig], StorageBackend]`; import `LocalConfig, StorageConfig` from `app.storage.config`; the `local` factory becomes `def _build_local_backend(settings, config): return LocalStorageBackend(settings.library_root)` (ignores `config`); rewrite `get_backend`:
  ```python
  def get_backend(settings: Settings, config: StorageConfig | None = None) -> StorageBackend:
      cfg = config if config is not None else LocalConfig()
      try:
          factory = _REGISTRY[cfg.backend]
      except KeyError as e:
          raise StorageError(f"no storage backend registered for scheme {cfg.backend!r}") from e
      return factory(settings, cfg)
  ```

- [ ] **Step 6 — fix the existing registry test** `tests/test_storage_registry.py`: the `_factory` signature becomes `def _factory(settings, config): return sentinel`; `test_get_backend_unknown_scheme_raises` builds an unknown scheme by registering nothing and calling through a stub — replace it with a direct check that an unregistered `config.backend` raises. Concretely:
  ```python
  def test_get_backend_unknown_scheme_raises(tmp_path):
      settings = Settings(library_root=tmp_path / "library")
      class _Bogus(LocalConfig):
          backend: str = "nope"          # type: ignore[assignment]
      with pytest.raises(StorageError):
          get_backend(settings, _Bogus())
  ```
  and update `test_register_decorator_adds_a_new_scheme` to register `unit-test-scheme` and resolve it by passing a config whose `.backend == "unit-test-scheme"` (a tiny `LocalConfig` subclass as above). Keep `test_get_backend_returns_local_backend_rooted_at_library_root` calling `get_backend(settings)` (still valid).

- [ ] **Step 7 — rewire the async API dependency** `app/api/deps.py`: `get_storage_backend` becomes async and DB-aware:
  ```python
  async def get_storage_backend(
      db: AsyncSession = Depends(get_db),
      settings: Settings = Depends(get_settings),
  ) -> StorageBackend:
      from app.services.storage_config import resolve_backend
      return await resolve_backend(db, settings)
  ```
  (FastAPI awaits async dependencies; every `Depends(get_storage_backend)` call site is unchanged.) Drop the now-unused `from app.storage.registry import get_backend` import if nothing else uses it.

- [ ] **Step 8 — rewire the sync worker call sites** `app/tasks/ingest.py` and `app/tasks/pipeline.py`: replace `backend = get_backend(settings)` with a resolve inside a sync session. Ingest (`store_to_backend`): after `settings = get_settings()`, do `with base.sync_session() as session: backend = resolve_backend_sync(session, settings)` (a short read-only session just to resolve; the write itself uses `backend` afterward). Pipeline `run_step` (line ~383): replace `backend = get_backend(settings)` with `backend = resolve_backend_sync(session, settings)` reusing the step's already-open `session`. Import `from app.services.storage_config import resolve_backend_sync`. **Fold M2-Minor 2 here:** in `run_step`, guard the `blob = session.get(Blob, blob_hash)` result — `if blob is None: mark_failed(session, job_id, f"blob {blob_hash} not found"); return` — before calling `fn`.

- [ ] **Step 9 — run tests.** `uv run pytest tests/test_storage_config.py tests/test_storage_registry.py tests/test_ingest*.py tests/test_pipeline_driver.py -v` → GREEN. Then the full suite `uv run pytest` (uploads still write local because the default config is Local). Ruff clean.

- [ ] **Step 10 — commit.** `git add -A && git commit -m "Add DB-backed storage-config seam: per-backend pydantic models + resolver"`.

**Accept:** active backend is chosen from the `settings` table (defaults to local when unset); ingest/pipeline/API all resolve through one seam; existing upload/download flow unchanged; `blob is None` in `run_step` fails cleanly.

---

## Task 2: Storage-contract test suite + Samba/MinIO testcontainer fixtures

SPEC "Verification": "storage backends against a temp dir + MinIO + dockerized Samba in CI." This task lands the **single parameterized contract suite all three backends must pass**, and the container fixtures — BEFORE the SMB/S3 backends exist, so Tasks 3–4 are literally "make my parameter go green." Only the `local` parameter runs now; `smb`/`s3` skip with a "lands in Task N" reason (their containers stay unstarted until the skip is removed, so no wasted CI time here).

**Files:**
- Create: `backend/tests/storage_containers.py` (container fixtures), `backend/tests/test_storage_contract.py` (the shared suite)
- Modify: `backend/tests/conftest.py` (register the new fixtures / plugin import)

**Interfaces (Tasks 3–4 consume these — keep names exact):**
- `tests/storage_containers.py` exposes session-scoped fixtures `samba_container` and `minio_container`, and function-scoped factory fixtures `smb_backend` and `s3_backend` returning a fresh, empty backend rooted at a unique per-test namespace.
- `tests/test_storage_contract.py` exposes a function-scoped `storage_backend` fixture parameterized `["local", "smb", "s3"]` (via `pytest.fixture(params=...)`), yielding an empty `StorageBackend`. Every contract test takes `storage_backend` and asserts backend-agnostic behavior only.

- [ ] **Step 1 — container fixtures** `tests/storage_containers.py`:
  ```python
  import io, uuid
  import boto3
  import pytest
  import smbclient
  from botocore.client import Config as BotoConfig
  from testcontainers.core.container import DockerContainer
  from testcontainers.core.waiting_utils import wait_for_logs
  from testcontainers.minio import MinioContainer

  from app.storage.config import S3Config, SmbConfig
  from app.storage.s3 import S3StorageBackend         # imported lazily inside the fixture (Task 4)
  from app.storage.smb import SmbStorageBackend        # imported lazily inside the fixture (Task 3)

  SMB_USER, SMB_PASS, SMB_SHARE = "tdmm", "tdmm-pass", "library"

  @pytest.fixture(scope="session")
  def samba_container():
      # dperson/samba CLI: -u "user;pass"  -s "share;/path;browse;readonly;guest;users"
      c = (DockerContainer("dperson/samba:latest")
           .with_command(f'-u "{SMB_USER};{SMB_PASS}" '
                         f'-s "{SMB_SHARE};/share;yes;no;no;{SMB_USER}" -p')
           .with_exposed_ports(445))
      c.start()
      try:
          wait_for_logs(c, "daemon 'smbd' finished starting up", timeout=60)
          yield c
      finally:
          smbclient.reset_connection_cache()
          c.stop()

  @pytest.fixture(scope="session")
  def minio_container():
      with MinioContainer() as c:
          yield c
  ```
  Note the SMB backend import is deferred (module doesn't exist until Task 3); to keep collection working now, import `SmbStorageBackend`/`S3StorageBackend` **inside** `smb_backend`/`s3_backend` rather than at module top. Rewrite the two `from app.storage.{smb,s3}` lines as local imports in Step 2's factories and delete them from the header.

- [ ] **Step 2 — backend factory fixtures** (same file): each yields an empty backend at a unique namespace so tests never collide:
  ```python
  @pytest.fixture
  def smb_backend(samba_container):
      from app.storage.smb import SmbStorageBackend
      host = samba_container.get_container_host_ip()
      port = int(samba_container.get_exposed_port(445))
      root = f"t-{uuid.uuid4().hex}"
      cfg = SmbConfig(host=host, share=SMB_SHARE, root=root, username=SMB_USER,
                      password=SMB_PASS, port=port, encrypt=False)  # encrypt off for the throwaway container
      backend = SmbStorageBackend(cfg)
      backend.mkdirs("")           # create the per-test root
      yield backend
      smbclient.reset_connection_cache()

  @pytest.fixture
  def s3_backend(minio_container):
      from app.storage.s3 import S3StorageBackend
      cfg_conn = minio_container.get_config()   # {"endpoint","access_key","secret_key"}
      endpoint = f"http://{cfg_conn['endpoint']}"
      bucket = f"tdmm-{uuid.uuid4().hex}"
      s3 = boto3.client("s3", endpoint_url=endpoint,
                        aws_access_key_id=cfg_conn["access_key"],
                        aws_secret_access_key=cfg_conn["secret_key"],
                        config=BotoConfig(s3={"addressing_style": "path"}))
      s3.create_bucket(Bucket=bucket)
      cfg = S3Config(bucket=bucket, access_key=cfg_conn["access_key"],
                     secret_key=cfg_conn["secret_key"], endpoint_url=endpoint,
                     prefix="lib", addressing="path")
      yield S3StorageBackend(cfg)
  ```
  Register the module as a plugin: in `tests/conftest.py` add `pytest_plugins = ("tests.storage_containers",)` at module top (or `from tests.storage_containers import *  # noqa` — prefer the plugin form).

- [ ] **Step 3 — the contract suite** `tests/test_storage_contract.py`. The `storage_backend` fixture selects the concrete backend by param, skipping the not-yet-built ones:
  ```python
  import os
  from datetime import UTC, datetime, timedelta
  import blake3, pytest
  from app.storage.base import EntryInfo
  from app.storage.errors import StorageError, StorageKeyNotFound
  from app.storage.local import LocalStorageBackend

  @pytest.fixture(params=["local", "smb", "s3"])
  def storage_backend(request, tmp_path):
      if request.param == "local":
          return LocalStorageBackend(tmp_path / "library")
      if request.param == "smb":
          pytest.skip("SMB backend lands in Task 3")   # remove in Task 3
      if request.param == "s3":
          pytest.skip("S3 backend lands in Task 4")     # remove in Task 4
  ```
  Then the backend-agnostic contract (each takes `storage_backend`). Cover at least:
  ```python
  def test_write_read_round_trip_and_hash(storage_backend):
      payload = b"contract" * 5000
      r = storage_backend.write("a/b.bin", [payload[:9000], payload[9000:]])
      assert r.hash == blake3.blake3(payload).hexdigest()
      assert r.size == len(payload)
      assert b"".join(storage_backend.read("a/b.bin")) == payload

  def test_ranged_read(storage_backend):
      storage_backend.write("r.bin", [b"0123456789"])
      assert b"".join(storage_backend.read("r.bin", 2, 5)) == b"234"

  def test_read_missing_raises_immediately(storage_backend):
      with pytest.raises(StorageKeyNotFound):
          list(storage_backend.read("nope.bin"))

  def test_exists(storage_backend):
      assert storage_backend.exists("x") is False
      storage_backend.write("x", [b"y"])
      assert storage_backend.exists("x") is True

  def test_stat_size_and_utc_mtime(storage_backend):
      storage_backend.write("s.bin", [b"12345"])
      st = storage_backend.stat("s.bin")
      assert st.size == 5
      assert st.mtime.tzinfo is not None
      assert abs(datetime.now(UTC) - st.mtime) < timedelta(minutes=10)

  def test_stat_missing_raises(storage_backend):
      with pytest.raises(StorageKeyNotFound):
          storage_backend.stat("gone")

  def test_copy_identical_bytes(storage_backend):
      storage_backend.write("src", [b"payload"])
      storage_backend.copy("src", "dst")
      assert b"".join(storage_backend.read("dst")) == b"payload"
      assert b"".join(storage_backend.read("src")) == b"payload"

  def test_move_relocates_and_removes_source(storage_backend):
      storage_backend.write("m1", [b"z"])
      storage_backend.move("m1", "m2")
      assert storage_backend.exists("m2") and not storage_backend.exists("m1")

  def test_delete_then_missing_delete_raises(storage_backend):
      storage_backend.write("d", [b"z"]); storage_backend.delete("d")
      assert not storage_backend.exists("d")
      with pytest.raises(StorageKeyNotFound):
          storage_backend.delete("d")

  def test_walk_nested_sorted_files_only(storage_backend):
      storage_backend.write("z.bin", [b"1"])
      storage_backend.write("dir/a.bin", [b"22"])
      storage_backend.write("dir/sub/c.bin", [b"333"])
      entries = list(storage_backend.walk(""))
      keys = [e.key for e in entries]
      assert keys == ["dir/a.bin", "dir/sub/c.bin", "z.bin"]   # per-dir bare-name, depth-first
      assert all(isinstance(e, EntryInfo) for e in entries)
      by_key = {e.key: e.size for e in entries}
      assert by_key["dir/a.bin"] == 2 and by_key["dir/sub/c.bin"] == 3

  def test_walk_prefix_scopes(storage_backend):
      storage_backend.write("p/one.bin", [b"1"]); storage_backend.write("q/two.bin", [b"2"])
      assert [e.key for e in storage_backend.walk("p")] == ["p/one.bin"]

  def test_walk_missing_prefix_yields_nothing(storage_backend):
      assert list(storage_backend.walk("absent")) == []

  def test_write_atomic_no_partial_on_mid_write_exception(storage_backend):
      def chunks():
          yield b"first"; raise RuntimeError("boom")
      with pytest.raises(RuntimeError):
          storage_backend.write("atomic.bin", chunks())
      assert not storage_backend.exists("atomic.bin")

  def test_write_preserves_existing_on_mid_write_exception(storage_backend):
      storage_backend.write("keep.bin", [b"original"])
      def chunks():
          yield b"new"; raise RuntimeError("boom")
      with pytest.raises(RuntimeError):
          storage_backend.write("keep.bin", chunks())
      assert b"".join(storage_backend.read("keep.bin")) == b"original"

  @pytest.mark.parametrize("bad", ["", ".", "..", "/abs", "a/../b", "a\\b"])
  def test_rejects_unsafe_keys(storage_backend, bad):
      with pytest.raises(StorageError):
          storage_backend.write(bad, [b"x"])
  ```
  The ordering test is the load-bearing one: it pins the "sort each directory's entries by bare name, recurse depth-first" contract that the S3 backend (Task 4) must replicate over a flat listing. Key-safety rejection is required of every backend (they all reject `..`/absolute/backslash/empty/`.`).

- [ ] **Step 4 — run.** `uv run pytest tests/test_storage_contract.py -v` → the `local` parameter passes; `smb`/`s3` show as SKIPPED. Confirm `local` covers every contract test (no accidental local-only leakage). Ruff clean.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add parameterized storage-contract suite + Samba/MinIO container fixtures"`.

**Accept:** the contract suite is green for `local`; `smb`/`s3` skip with a clear reason; Samba + MinIO fixtures exist and are unstarted until a backend needs them.

---

## Task 3: SMB backend (`smbprotocol` / `smbclient`)

SPEC "Storage layer" SMB row + "SMB: lazy per-process sessions … `scandir` with `smb_info` … IP/DNS addressing". RESEARCH §1/§5. This task turns the contract suite's `smb` parameter green.

**Files:**
- Create: `backend/app/storage/smb.py`, `backend/tests/test_storage_smb.py`
- Modify: `backend/app/storage/registry.py` (register `smb`), `backend/tests/test_storage_contract.py` (remove the `smb` skip)

**Interfaces (consumed by registry + contract suite):**
- `class SmbStorageBackend:` constructed `SmbStorageBackend(config: SmbConfig)`; implements the full `StorageBackend` protocol; translates SMB not-found → `StorageKeyNotFound`; validates keys with the same rules as local (reject empty/`.`/`..`/absolute/backslash) via a shared `_safe_key` helper.
- Registry entry `@register("smb")` factory `_build_smb(settings, config)` → `SmbStorageBackend(config)` (asserts `isinstance(config, SmbConfig)`).

- [ ] **Step 1 — remove the smb skip** in `test_storage_contract.py`: delete the `if request.param == "smb": pytest.skip(...)` line and return `request.getfixturevalue("smb_backend")`. Run `uv run pytest tests/test_storage_contract.py -k smb -v` → RED (import error: `app.storage.smb` missing). This is the RED gate for the whole task.

- [ ] **Step 2 — smb-specific unit tests** `tests/test_storage_smb.py` (things the generic contract can't see):
  ```python
  import smbclient, pytest
  from app.storage.smb import SmbStorageBackend, _UNC

  def test_scandir_uses_smb_info_not_per_entry_stat(smb_backend, monkeypatch):
      smb_backend.write("d/a.bin", [b"1"]); smb_backend.write("d/b.bin", [b"22"])
      calls = {"stat": 0}
      real_stat = smbclient.stat
      monkeypatch.setattr(smbclient, "stat", lambda *a, **k: (calls.__setitem__("stat", calls["stat"]+1), real_stat(*a, **k))[1])
      list(smb_backend.walk(""))
      assert calls["stat"] == 0        # sizes/mtimes come from SMBDirEntry.smb_info, no N+1 stat

  def test_unc_path_construction():
      assert _UNC("host", "share", "a/b.bin") == r"\\host\share\a\b.bin"

  def test_write_leaves_no_temp_artifact(smb_backend):
      smb_backend.write("clean.bin", [b"x"])
      names = [e.key for e in smb_backend.walk("")]
      assert names == ["clean.bin"]    # UUID temp was renamed away, not left behind
  ```

- [ ] **Step 3 — implement the SMB backend** `app/storage/smb.py`. Full module:
  ```python
  """SMB StorageBackend (SPEC "Storage layer" SMB row).

  smbprotocol high-level ``smbclient`` API. Sessions are registered LAZILY,
  once per worker process (Celery prefork forks children -- a session opened
  in the parent is unusable in a child), guarded by a per-(host,port,user)
  key. UUID-temp + ``smbclient.replace`` gives POSIX-rename atomicity; SMB2
  COPYCHUNK (server-side) via ``smbclient.copyfile`` makes snapshot copies
  near-instant on capable servers (1.16.1 auto-falls-back client-side).
  ``scandir`` reads size/mtime from ``SMBDirEntry.smb_info`` -- no N+1 stat.
  """
  from __future__ import annotations
  import uuid
  from collections.abc import Iterable, Iterator
  from datetime import UTC, datetime

  import blake3
  import smbclient
  from smbprotocol.exceptions import SMBOSError, SMBResponseException

  from app.storage.base import EntryInfo, StatResult, WriteResult
  from app.storage.config import SmbConfig
  from app.storage.errors import StorageError, StorageKeyNotFound

  _READ_CHUNK = 1024 * 1024
  _TMP_PREFIX = ".tdmm-tmp-"          # same reservation contract as local (walk filters it)
  _registered: set[tuple[str, int, str]] = set()   # process-local session registry


  def _safe_key(key: str) -> str:
      if key in ("", ".") or key.startswith("/") or "\\" in key:
          raise StorageError(f"unsafe storage key: {key!r}")
      parts = key.split("/")
      if any(p in ("", ".", "..") or p.startswith(_TMP_PREFIX) for p in parts):
          raise StorageError(f"unsafe storage key: {key!r}")
      return key


  def _safe_prefix(prefix: str) -> str:
      if prefix in ("", "."):
          return ""
      return _safe_key(prefix)


  def _UNC(host: str, share: str, key: str) -> str:
      tail = key.replace("/", "\\")
      return rf"\\{host}\{share}\{tail}" if tail else rf"\\{host}\{share}"


  class SmbStorageBackend:
      def __init__(self, config: SmbConfig) -> None:
          self._c = config
          root = config.root.strip("/")
          self._root = root  # POSIX subpath within the share; "" = share root

      # -- session -------------------------------------------------------
      def _ensure_session(self) -> None:
          key = (self._c.host, self._c.port, self._c.username)
          if key in _registered:
              return
          smbclient.register_session(
              self._c.host, username=self._c.username, password=self._c.password,
              port=self._c.port, encrypt=self._c.encrypt,
          )
          _registered.add(key)

      def _path(self, key: str) -> str:
          full = f"{self._root}/{key}".strip("/") if self._root else key
          return _UNC(self._c.host, self._c.share, full)

      def _dir_of(self, key: str) -> str:
          full = f"{self._root}/{key}".strip("/") if self._root else key
          parent = "/".join(full.split("/")[:-1])
          return _UNC(self._c.host, self._c.share, parent)

      # -- protocol ------------------------------------------------------
      def write(self, key: str, chunks: Iterable[bytes]) -> WriteResult:
          _safe_key(key); self._ensure_session()
          dest = self._path(key)
          self.mkdirs("/".join(key.split("/")[:-1]))
          tmp = self._dir_of(key) + "\\" + f"{_TMP_PREFIX}{uuid.uuid4().hex}"
          hasher = blake3.blake3(); size = 0
          try:
              with smbclient.open_file(tmp, mode="wb") as fh:
                  for chunk in chunks:
                      hasher.update(chunk); size += len(chunk); fh.write(chunk)
              smbclient.replace(tmp, dest)          # atomic rename-with-replace
          except BaseException:
              with _suppress(): smbclient.remove(tmp)
              raise
          return WriteResult(hash=hasher.hexdigest(), size=size)

      def read(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
          _safe_key(key); self._ensure_session()
          try:
              fh = smbclient.open_file(self._path(key), mode="rb")
          except SMBOSError as e:
              raise StorageKeyNotFound(key) from e
          def _gen() -> Iterator[bytes]:
              with fh:
                  if start: fh.seek(start)
                  remaining = None if end is None else end - start
                  while True:
                      n = _READ_CHUNK if remaining is None else min(_READ_CHUNK, remaining)
                      if n <= 0: break
                      buf = fh.read(n)
                      if not buf: break
                      if remaining is not None: remaining -= len(buf)
                      yield buf
          return _gen()

      def copy(self, src: str, dst: str) -> None:
          _safe_key(src); _safe_key(dst); self._ensure_session()
          if not self.exists(src):
              raise StorageKeyNotFound(src)
          self.mkdirs("/".join(dst.split("/")[:-1]))
          tmp = self._dir_of(dst) + "\\" + f"{_TMP_PREFIX}{uuid.uuid4().hex}"
          try:
              smbclient.copyfile(self._path(src), tmp)   # SMB2 COPYCHUNK, client fallback in 1.16.1
              smbclient.replace(tmp, self._path(dst))
          except BaseException:
              with _suppress(): smbclient.remove(tmp)
              raise

      def move(self, src: str, dst: str) -> None:
          _safe_key(src); _safe_key(dst); self._ensure_session()
          self.mkdirs("/".join(dst.split("/")[:-1]))
          try:
              smbclient.replace(self._path(src), self._path(dst))
          except SMBOSError as e:
              raise StorageKeyNotFound(src) from e

      def delete(self, key: str) -> None:
          _safe_key(key); self._ensure_session()
          try:
              smbclient.remove(self._path(key))
          except SMBOSError as e:
              raise StorageKeyNotFound(key) from e

      def exists(self, key: str) -> bool:
          _safe_key(key); self._ensure_session()
          try:
              smbclient.stat(self._path(key)); return True
          except SMBOSError:
              return False

      def stat(self, key: str) -> StatResult:
          _safe_key(key); self._ensure_session()
          try:
              info = smbclient.stat(self._path(key))
          except SMBOSError as e:
              raise StorageKeyNotFound(key) from e
          return StatResult(size=info.st_size,
                            mtime=datetime.fromtimestamp(info.st_mtime, tz=UTC))

      def walk(self, prefix: str = "") -> Iterator[EntryInfo]:
          self._ensure_session()
          base = _safe_prefix(prefix)
          root_full = f"{self._root}/{base}".strip("/") if self._root else base
          yield from self._walk_dir(root_full, base)

      def _walk_dir(self, full_dir: str, rel_dir: str) -> Iterator[EntryInfo]:
          unc = _UNC(self._c.host, self._c.share, full_dir)
          try:
              entries = sorted(smbclient.scandir(unc), key=lambda e: e.name)
          except SMBOSError:
              return
          for e in entries:
              if e.name.startswith(_TMP_PREFIX):
                  continue
              child_rel = f"{rel_dir}/{e.name}".strip("/")
              child_full = f"{full_dir}/{e.name}".strip("/")
              if e.is_dir():
                  yield from self._walk_dir(child_full, child_rel)
              else:
                  info = e.smb_info            # 1.16.1: sizes/mtimes without a per-entry stat
                  yield EntryInfo(
                      key=child_rel,
                      size=info.end_of_file,
                      mtime=_filetime_to_utc(info.last_write_time),
                  )

      def mkdirs(self, key_prefix: str) -> None:
          self._ensure_session()
          rel = _safe_prefix(key_prefix)
          full = f"{self._root}/{rel}".strip("/") if self._root else rel
          if not full:
              return
          smbclient.makedirs(_UNC(self._c.host, self._c.share, full), exist_ok=True)
  ```
  Add the two small helpers at module scope: `_suppress()` = `contextlib.suppress(Exception)`; `_filetime_to_utc(ft)` converts smbprotocol's `FileTime`/`last_write_time` to a tz-aware UTC datetime (smbprotocol exposes these as `datetime` already in recent versions — if `info.last_write_time` is already a tz-aware datetime, coerce with `.astimezone(UTC)`; the test `test_stat_size_and_utc_mtime` pins tz-awareness). Confirm the exact `smb_info` attribute names against the installed smbprotocol during implementation (`end_of_file`/`last_write_time` are the SMB2 `FILE_ID_FULL_DIR_INFORMATION` names) and adjust if the pinned version differs — the contract test is the ground truth.

- [ ] **Step 3.1 — register.** In `registry.py`: import `SmbConfig` and `SmbStorageBackend`; add
  ```python
  @register("smb")
  def _build_smb_backend(settings: Settings, config: StorageConfig) -> StorageBackend:
      assert isinstance(config, SmbConfig)
      return SmbStorageBackend(config)
  ```

- [ ] **Step 4 — run.** `uv run pytest tests/test_storage_contract.py -k smb tests/test_storage_smb.py -v` → GREEN (Samba container starts on first `smb_backend` use). Then `uv run pytest tests/test_storage_contract.py -v` → all three of {local, smb, (s3 still skipped)} report correctly. Ruff clean.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add SMB storage backend (smbclient: lazy sessions, scandir smb_info, COPYCHUNK)"`.

**Accept:** every contract test passes against the real Samba container; `scandir` walk issues zero per-entry `stat` calls; write leaves no UUID-temp artifact; a moved file relinks without re-download semantics being violated (contract `move`/`copy` green).

---

## Task 4: S3 backend (`boto3`)

SPEC "Storage layer" S3 row + "PUT/MPU all-or-nothing; lifecycle rule expires incomplete MPUs". RESEARCH §1/§5. Turns the contract suite's `s3` parameter green. **No temp+rename** — S3 has no atomic rename; identity is the all-or-nothing PUT/CompleteMPU.

**Files:**
- Create: `backend/app/storage/s3.py`, `backend/tests/test_storage_s3.py`
- Modify: `backend/app/storage/registry.py` (register `s3`), `backend/tests/test_storage_contract.py` (remove the `s3` skip)

**Interfaces:**
- `class S3StorageBackend:` constructed `S3StorageBackend(config: S3Config)`; full protocol; `mkdirs` is a no-op (no directory objects); translates 404/`NoSuchKey` → `StorageKeyNotFound`; `walk` replicates the per-directory bare-name depth-first order from a flat paginated listing (NOT S3's lexicographic key order — see the ordering contract).
- Registry `@register("s3")` factory `_build_s3(settings, config)` → `S3StorageBackend(config)`.

- [ ] **Step 1 — remove the s3 skip** in `test_storage_contract.py`: return `request.getfixturevalue("s3_backend")` for the `s3` param. Run `uv run pytest tests/test_storage_contract.py -k s3 -v` → RED (`app.storage.s3` missing). RED gate.

- [ ] **Step 2 — s3-specific unit tests** `tests/test_storage_s3.py`:
  ```python
  import os, pytest
  from app.storage.s3 import S3StorageBackend, _MPU_THRESHOLD

  def test_multipart_upload_for_large_object(s3_backend):
      payload = os.urandom(_MPU_THRESHOLD + 1024)       # forces MPU path
      r = s3_backend.write("big.bin", [payload])
      assert r.size == len(payload)
      assert b"".join(s3_backend.read("big.bin")) == payload

  def test_walk_reconstructs_per_dir_order_not_lexicographic(s3_backend):
      # "ab.bin" vs sibling dir "ab/child.bin": full-key lexicographic would put
      # ab.bin first ('.' < '/'); the per-dir bare-name contract puts the "ab"
      # subtree first because bare "ab" < bare "ab.bin".
      s3_backend.write("ab.bin", [b"1"]); s3_backend.write("ab/child.bin", [b"2"])
      assert [e.key for e in s3_backend.walk("")] == ["ab/child.bin", "ab.bin"]

  def test_stat_uses_head_not_etag_identity(s3_backend):
      s3_backend.write("h.bin", [b"12345"])
      assert s3_backend.stat("h.bin").size == 5     # size from HEAD; ETag never used as identity

  def test_mid_write_exception_leaves_no_object(s3_backend):
      def chunks():
          yield b"x"; raise RuntimeError("boom")
      with pytest.raises(RuntimeError):
          s3_backend.write("never.bin", chunks())
      assert not s3_backend.exists("never.bin")
  ```

- [ ] **Step 3 — implement the S3 backend** `app/storage/s3.py`. Full module:
  ```python
  """S3 StorageBackend (SPEC "Storage layer" S3 row).

  boto3 only (RESEARCH §1 rejects s3fs/aiobotocore). No temp+rename: S3 has
  no atomic rename, and an object is never partially visible -- a PUT or
  CompleteMultipartUpload either fully materializes the key or nothing does,
  so we write straight to the final key and let the DB commit be the txn
  boundary. Aborted MPUs leave invisible parts; the operator sets a bucket
  lifecycle rule to expire incomplete multipart uploads (documented in the
  Settings UI; we do not create it). ETags are NOT content hashes for
  multipart objects -- the scanner compares SIZE only on S3, never ETag.
  """
  from __future__ import annotations
  from collections.abc import Iterable, Iterator
  from datetime import UTC

  import blake3
  import boto3
  from botocore.client import Config as BotoConfig
  from botocore.exceptions import ClientError

  from app.storage.base import EntryInfo, StatResult, WriteResult
  from app.storage.config import S3Config
  from app.storage.errors import StorageError, StorageKeyNotFound

  _READ_CHUNK = 1024 * 1024
  _MPU_THRESHOLD = 8 * 1024 * 1024      # buffer up to this as a single PUT; larger streams as MPU
  _PART_SIZE = 8 * 1024 * 1024          # >= S3's 5 MiB minimum part size


  def _safe_key(key: str) -> str:
      if key in ("", ".") or key.startswith("/") or "\\" in key:
          raise StorageError(f"unsafe storage key: {key!r}")
      if any(p in ("", ".", "..") for p in key.split("/")):
          raise StorageError(f"unsafe storage key: {key!r}")
      return key


  class S3StorageBackend:
      def __init__(self, config: S3Config) -> None:
          self._c = config
          self._prefix = config.prefix.strip("/")
          self._s3 = boto3.client(
              "s3", endpoint_url=config.endpoint_url, region_name=config.region,
              aws_access_key_id=config.access_key, aws_secret_access_key=config.secret_key,
              config=BotoConfig(s3={"addressing_style": config.addressing}),
          )

      def _obj(self, key: str) -> str:
          return f"{self._prefix}/{key}".strip("/") if self._prefix else key

      def _rel(self, obj_key: str) -> str:
          return obj_key[len(self._prefix) + 1:] if self._prefix else obj_key

      # -- write: PUT (small) or MPU (large), all-or-nothing ------------
      def write(self, key: str, chunks: Iterable[bytes]) -> WriteResult:
          _safe_key(key)
          hasher = blake3.blake3()
          buf = bytearray(); size = 0
          it = iter(chunks)
          # Buffer until we cross the MPU threshold or the stream ends.
          for chunk in it:
              hasher.update(chunk); size += len(chunk); buf.extend(chunk)
              if len(buf) > _MPU_THRESHOLD:
                  return self._write_mpu(key, bytes(buf), it, hasher, size)
          self._s3.put_object(Bucket=self._c.bucket, Key=self._obj(key), Body=bytes(buf))
          return WriteResult(hash=hasher.hexdigest(), size=size)

      def _write_mpu(self, key, first: bytes, rest, hasher, size) -> WriteResult:
          obj = self._obj(key)
          up = self._s3.create_multipart_upload(Bucket=self._c.bucket, Key=obj)
          upload_id = up["UploadId"]; parts = []; pending = bytearray(first)
          try:
              def _flush(final: bool):
                  while len(pending) >= _PART_SIZE or (final and pending):
                      take = bytes(pending[:_PART_SIZE]); del pending[:_PART_SIZE]
                      n = len(parts) + 1
                      r = self._s3.upload_part(Bucket=self._c.bucket, Key=obj,
                                               UploadId=upload_id, PartNumber=n, Body=take)
                      parts.append({"ETag": r["ETag"], "PartNumber": n})
                      if not final:
                          break
              _flush(final=False)
              for chunk in rest:
                  hasher.update(chunk); size += len(chunk); pending.extend(chunk)
                  _flush(final=False)
              _flush(final=True)
              self._s3.complete_multipart_upload(
                  Bucket=self._c.bucket, Key=obj, UploadId=upload_id,
                  MultipartUpload={"Parts": parts})
          except BaseException:
              self._s3.abort_multipart_upload(Bucket=self._c.bucket, Key=obj, UploadId=upload_id)
              raise
          return WriteResult(hash=hasher.hexdigest(), size=size)

      def read(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
          _safe_key(key)
          rng = {}
          if start or end is not None:
              rng["Range"] = f"bytes={start}-{'' if end is None else end - 1}"
          try:
              resp = self._s3.get_object(Bucket=self._c.bucket, Key=self._obj(key), **rng)
          except ClientError as e:
              if _is_not_found(e): raise StorageKeyNotFound(key) from e
              raise
          def _gen() -> Iterator[bytes]:
              body = resp["Body"]
              try:
                  while True:
                      buf = body.read(_READ_CHUNK)
                      if not buf: break
                      yield buf
              finally:
                  body.close()
          return _gen()

      def copy(self, src: str, dst: str) -> None:
          _safe_key(src); _safe_key(dst)
          try:
              self._s3.copy_object(Bucket=self._c.bucket, Key=self._obj(dst),
                                   CopySource={"Bucket": self._c.bucket, "Key": self._obj(src)})
          except ClientError as e:
              if _is_not_found(e): raise StorageKeyNotFound(src) from e
              raise

      def move(self, src: str, dst: str) -> None:
          self.copy(src, dst); self.delete(src)

      def delete(self, key: str) -> None:
          _safe_key(key)
          if not self.exists(key):
              raise StorageKeyNotFound(key)
          self._s3.delete_object(Bucket=self._c.bucket, Key=self._obj(key))

      def exists(self, key: str) -> bool:
          _safe_key(key)
          try:
              self._s3.head_object(Bucket=self._c.bucket, Key=self._obj(key)); return True
          except ClientError as e:
              if _is_not_found(e): return False
              raise

      def stat(self, key: str) -> StatResult:
          _safe_key(key)
          try:
              h = self._s3.head_object(Bucket=self._c.bucket, Key=self._obj(key))
          except ClientError as e:
              if _is_not_found(e): raise StorageKeyNotFound(key) from e
              raise
          return StatResult(size=h["ContentLength"],
                            mtime=h["LastModified"].astimezone(UTC))

      def walk(self, prefix: str = "") -> Iterator[EntryInfo]:
          # Flat paginated listing, then RE-SORT into the per-directory
          # bare-name depth-first order the protocol requires (S3 returns
          # lexicographic full-key order, which is NOT the same -- see base.py).
          base = "" if prefix in ("", ".") else _safe_key(prefix)
          list_prefix = self._obj(base)
          if list_prefix and not list_prefix.endswith("/"):
              list_prefix += "/"
          collected: list[EntryInfo] = []
          paginator = self._s3.get_paginator("list_objects_v2")
          for page in paginator.paginate(Bucket=self._c.bucket, Prefix=list_prefix):
              for o in page.get("Contents", []):
                  collected.append(EntryInfo(key=self._rel(o["Key"]), size=o["Size"],
                                             mtime=o["LastModified"].astimezone(UTC)))
          yield from _reorder_per_directory(collected)

      def mkdirs(self, key_prefix: str) -> None:
          return  # S3 has no directories
  ```
  Module helpers: `_is_not_found(e)` → `e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound")`; `_reorder_per_directory(entries)` builds a nested dict tree keyed by path segment, then yields depth-first with each directory's entries sorted by bare segment name (files and subdirs interleaved by name, subtree emitted when the dir's name falls in order) — this is exactly the local `_walk_dir` ordering, reconstructed. Implement `_reorder_per_directory` as a small recursive tree walk; the contract's `test_walk_nested_sorted_files_only` and s3's `test_walk_reconstructs_per_dir_order_not_lexicographic` pin it.

- [ ] **Step 3.1 — register.** In `registry.py`: import `S3Config`/`S3StorageBackend`; add `@register("s3")` factory mirroring the SMB one.

- [ ] **Step 4 — run.** `uv run pytest tests/test_storage_contract.py tests/test_storage_s3.py -v` → GREEN for all three parameters + s3-specifics (MinIO container starts on first `s3_backend` use). Ruff clean. This is the milestone's "all three backends prove identical semantics" gate.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add S3 storage backend (boto3: PUT/MPU all-or-nothing, CopyObject, paginated walk)"`.

**Accept:** the full contract suite is green across local/smb/s3; S3 walk honors the per-directory ordering contract (not lexicographic); large objects go through MPU and abort cleanly on mid-write failure; stat/exists use HEAD; ETags are never used as identity.

---

## Task 5: `scan_library` reconciler + `scan_runs` report + scan API

SPEC "Rescan/reconcile (`scan_library`)" (the numbered algorithm) + "M3 … `scan_library` + report UI". Scanner tests run on the **local** backend (the algorithm is backend-agnostic; local is cheapest and the contract suite already proved SMB/S3 satisfy the same protocol). **The scanner never deletes** (Global Constraints).

**Files:**
- Create: `backend/alembic/versions/<rev>_add_model_review_state.py`, `backend/app/services/scanner.py`, `backend/app/tasks/scan.py`, `backend/app/api/scan.py`, `backend/app/schemas/scan.py`, `backend/tests/test_scanner.py`, `backend/tests/test_scan_api.py`
- Modify: `backend/app/models/library.py` (add `Model.review_state`), `backend/app/api/__init__.py` (mount scan router), `backend/app/tasks/celery_app.py` (imports + optional beat), `backend/app/services/library.py` (fold: `patch_model` rewrites the sidecar on name change), `backend/app/services/events.py` (reuse `job.updated` shape for scan progress)

**Interfaces (Task 8 UI consumes `ScanRunOut` + the endpoints; keep exact):**
- Migration: add nullable `models.review_state VARCHAR` (`down_revision = "2a2ad98de9a4"` — the first incremental migration in the repo). `Model.review_state: Mapped[str | None] = mapped_column(String)`; value `"adopted"` = "adopted, review me", `NULL` = normal. `patch_model` may clear it (allow `review_state` in the patch field list so the UI can dismiss the flag).
- `app/services/scanner.py`:
  ```python
  def run_scan(session: Session, settings: Settings, backend: StorageBackend, scan_run_id: int) -> None
  ```
  The whole reconcile pass, synchronous (worker world). Counters map 1:1 to `scan_runs` columns (`files_seen`, `files_hashed`, `relinked`, `adopted`, `missing`); the JSONB `report` carries the per-item lists (see shape below).
- `app/tasks/scan.py`:
  ```python
  @celery_app.task(name="app.tasks.scan.scan_library")
  def scan_library(scan_run_id: int) -> None      # Redis singleton lock; io queue
  ```
- `app/api/scan.py`: `POST /api/scan` → 409 if a run is `queued`/`running`, else create `ScanRun(state="queued")` + dispatch + return `ScanRunOut`; `GET /api/scan-runs?limit=` (1–100, default 20) → `list[ScanRunOut]`; `GET /api/scan-runs/{id}` → `ScanRunOut`.
- `app/schemas/scan.py`: `ScanRunOut` mirroring `ScanRun` columns 1:1 (`id, created_at, finished_at, state, files_seen, files_hashed, relinked, adopted, missing, report`).
- Report JSONB shape (frozen — Task 8 renders it):
  ```json
  {
    "adopted":  [{"model_id": int, "slug": str, "revision_id": int, "files": [str, ...]}],
    "relinked": [{"file_id": int, "from": str, "to": str, "hash": str}],
    "changed":  [{"file_id": int, "storage_path": str, "old_hash": str, "new_hash": str}],
    "missing":  [{"file_id": int, "storage_path": str, "model_slug": str}],
    "verified": int
  }
  ```

**Reconcile algorithm (SPEC decision table — implement exactly):**
1. Snapshot `{storage_path: (file_id, blob_hash, size, mtime)}` from `files` joined to `blobs` (size from `blobs.size`). Track a `seen` set.
2. `backend.walk("")` the tree. Skip the sidecar files (`.3dmm.json`) — they aren't `files` rows.
3. Per on-disk `EntryInfo`:
   - **Known path, unchanged** (size matches; and on local/SMB mtime matches within tolerance; on S3 size only — the active backend's scheme decides which comparison): `verified_at = now`, `files_hashed` unchanged; add to `report["verified"]` count; add path to `seen`.
   - **Known path, changed** (size/mtime differ): re-hash via `backend.read` streaming blake3 (`files_hashed += 1`). Same hash → update `mtime`, touch `verified_at`. New hash → upsert `Blob` (size/kind/format via `layout.infer_blob_kind_format(rel_path)`), repoint `file.blob_hash`, set `verified_at = now`, append to `report["changed"]`, and best-effort re-enqueue the pipeline for the new blob (`start_pipeline_sync`), swallowing dispatch errors (log-and-continue — a scan covers many files).
   - **Unknown path**: re-hash (`files_hashed += 1`). If the hash exists in `blobs`: **relink** — if some snapshot `file` row whose `storage_path` is now in the missing set shares this `blob_hash` and a matching `rel_path` tail, repoint that row's `storage_path` to the on-disk key (`relinked += 1`, `report["relinked"]`), else record an adopted duplicate (attach as a new `File` under the inferred model/revision, `adopted += 1`). If the hash is unknown: **adopt** — upsert the `Blob`; if the key fits `<slug>/<rev-dir>/<rel...>` under an existing model+revision, attach a `File` row to that revision; else create a **draft Model + rev-001** with `review_state="adopted"`, write its `.3dmm.json` sidecar, attach the `File`; `adopted += 1`, `report["adopted"]`; best-effort enqueue metadata/derivative pipeline for the new file's blob.
4. Snapshot paths never `seen` → `missing += 1`, `report["missing"]`. **Do NOT delete the row or the object.**
5. Set `verified` count, write counters + `report` onto the `ScanRun`, `state="done"`, `finished_at=now`.

- [ ] **Step 1 — migration + model column.** Add `Model.review_state` to `app/models/library.py`. Generate the first incremental migration: `uv run alembic revision -m "add model review_state"`, hand-edit `down_revision = "2a2ad98de9a4"`, `op.add_column("models", sa.Column("review_state", sa.String(), nullable=True))` + `op.drop_column` in `downgrade`. Run `uv run pytest tests/test_migration_drift.py -v` → GREEN (proves the column + migration match `Base.metadata`). If RED, fix the migration until the drift-guard is empty.

- [ ] **Step 2 — failing scanner tests** `tests/test_scanner.py` (local backend, direct `run_scan` calls; use `seed_file`/`backend`/`db_session`, and a sync session via `app.tasks.base.sync_session` mirrored — or drive through the task in eager mode). Cover the decision table:
  ```python
  # sketch — one test per row of the SPEC table
  def test_known_unchanged_touches_verified_at(...): ...        # verified_at set, no re-hash
  def test_known_changed_content_repoints_blob_and_reports(...): ...
  def test_unknown_path_matching_hash_relinks_moved_file(...): ...  # move folder on disk -> relink, files_hashed==1
  def test_unknown_folder_adopts_as_draft_model_review_me(...): ... # new Model, review_state=="adopted", sidecar written
  def test_unknown_path_under_existing_model_attaches_to_revision(...): ...
  def test_missing_db_path_marked_missing_never_deleted(...): ...   # File row still exists, object untouched, missing==1
  def test_scan_run_report_and_counters_persisted(...): ...
  ```
  The headline test `test_unknown_path_matching_hash_relinks_moved_file`: seed a model/revision/file on local disk, then physically move the on-disk folder to a new slug dir (via the backend or `os.rename` under `library_root`), run the scan, assert the `File.storage_path` repointed and `relinked == 1` and unchanged bytes were re-hashed **once** (the moved file) not the whole tree. Run → RED (`app.services.scanner` missing).

- [ ] **Step 3 — implement `scanner.py`** per the algorithm above. Reuse `app.services.layout` for path math (`slug_for`, `revision_dir_name`, `file_key`, `sidecar_key`, `infer_blob_kind_format`, `write_sidecar`) — do NOT reimplement layout. Stream re-hash with `blake3.blake3()` fed by `backend.read(storage_path)`. Determine the size/mtime-vs-size-only comparison from the active config's `backend` scheme (pass it in or read `config.backend`; S3 → size-only). Adoption sidecar via `layout.write_sidecar(backend, model.id, slug, name)`. Never call `backend.delete`/`backend.move` on library content (a `move`-based relink is a DB `storage_path` repoint + optional physical normalization — but per Global Constraints, prefer repointing the DB to the on-disk location and leaving bytes where the user put them; only the DB changes).

- [ ] **Step 4 — implement the Celery task** `app/tasks/scan.py`:
  ```python
  from redis import Redis
  from app.config import get_settings
  from app.services import scanner, jobs
  from app.services.storage_config import resolve_backend_sync
  from app.services.events import publish_scan_event_sync
  from app.tasks import base
  from app.tasks.celery_app import celery_app

  _LOCK_KEY = "tdmm:scan:lock"

  @celery_app.task(name="app.tasks.scan.scan_library")
  def scan_library(scan_run_id: int) -> None:
      settings = get_settings()
      client = Redis.from_url(settings.redis_url)
      lock = client.lock(_LOCK_KEY, timeout=3600, blocking=False)
      if not lock.acquire(blocking=False):
          with base.sync_session() as s:
              scanner.mark_scan_state(s, scan_run_id, "skipped")   # another run holds the lock
          return
      try:
          with base.sync_session() as s:
              scanner.mark_scan_state(s, scan_run_id, "running")
              publish_scan_event_sync(settings.redis_url, scan_run_id, "running")
              backend = resolve_backend_sync(s, settings)
              scanner.run_scan(s, settings, backend, scan_run_id)  # sets state=done, finished_at
              publish_scan_event_sync(settings.redis_url, scan_run_id, "done")
      except Exception:
          with base.sync_session() as s:
              scanner.mark_scan_state(s, scan_run_id, "failed")
              publish_scan_event_sync(settings.redis_url, scan_run_id, "failed")
          raise
      finally:
          import contextlib
          with contextlib.suppress(Exception): lock.release()
  ```
  Add `scanner.mark_scan_state(session, scan_run_id, state)` helper. Add `"app.tasks.scan"` to `celery_app.conf.imports`. The task is I/O-bound (walking a remote tree) → it lands on the `io` queue via the existing catch-all `app.tasks.* → io` (no new route needed; `app.tasks.scan.scan_library` does not match `app.tasks.pipeline.*`). **Optional scheduled scan:** below the `celery_app.conf.update(...)` block, add a conditional `beat_schedule` built from `settings` only when an interval is configured — read a `scan_interval_s` from the storage settings row or a dedicated `settings` key; if unset/zero, no beat entry. Document it as opt-in; default OFF.

- [ ] **Step 5 — scan event** `app/services/events.py`: add `publish_scan_event_sync(redis_url, scan_run_id, state)` that reuses the existing `job_event_payload` shape with `job_type="scan_library"`, `subject_type="scan_run"`, `subject_id=scan_run_id`, `job_id=str(scan_run_id)` — so the frontend's existing `job.updated` handler already invalidates `["models"]`/`["revisions"]` (adopted models appear) and Task 8 adds one branch keyed on `job_type === "scan_library"` to also invalidate `["scan"]`. No new SSE event type.

- [ ] **Step 6 — API + schema.** `app/schemas/scan.py`: `ScanRunOut` (Pydantic, `from_model` classmethod mirroring columns). `app/api/scan.py`: the three endpoints above; `POST /api/scan` guards against a concurrent run by querying for an existing `ScanRun.state in ("queued","running")` → 409 "a scan is already running". Dispatch with `scan_library.apply_async(args=[scan_run.id])`. Mount `scan.router` on `protected_router` in `app/api/__init__.py`.

- [ ] **Step 7 — sidecar-staleness fold.** In `app/services/library.py` `patch_model`: when `"name"` is in `changes` and changes the name, rewrite `.3dmm.json` — needs the backend, so add a `backend: StorageBackend` param to `patch_model` (update the single call site in `app/api/models.py` to inject `Depends(get_storage_backend)`), and after the name change do `await anyio.to_thread.run_sync(layout.write_sidecar, backend, model.id, model.slug, model.name)`. Allow `review_state` in the patch field list so the UI can clear an adopted flag. Add a regression test to `tests/test_models_api.py`: PATCH name → sidecar bytes on disk reflect the new name.

- [ ] **Step 8 — scan API tests** `tests/test_scan_api.py`: `POST /api/scan` creates a run + (eager) runs it to `done`; a second `POST` while one is `running` → 409 (simulate by inserting a `running` ScanRun); `GET /api/scan-runs` lists most-recent-first with the report; `GET /api/scan-runs/{id}` 200/404; auth sweep still green (register scan routes' path params if the sweep needs them). Under eager Celery the task body runs inline, so the end-to-end adopt/relink assertions can go through the API too.

- [ ] **Step 9 — run.** `uv run pytest tests/test_scanner.py tests/test_scan_api.py tests/test_migration_drift.py tests/test_models_api.py -v` → GREEN. Full suite green. Ruff clean.

- [ ] **Step 10 — commit.** `git add -A && git commit -m "Add scan_library reconciler, scan_runs report, and scan API"`.

**Accept:** dropping an untracked folder under the library and scanning adopts it as a draft model flagged review; moving a model folder relinks by hash and re-hashes only the moved file; a DB path gone from disk is reported `missing` with the row and object untouched; a run holds a Redis singleton lock; `scan_runs` carries counters + the report JSONB.

---

## Task 6: Storage settings API + connection-test + migration-helper job

SPEC "M3 … settings UI + connection test + local→X migration helper"; the settings surface is per-backend under the `settings` key (design.md:158/170). This task is the **backend** for the Settings page (Task 7 is its UI). Also folds **M2-Minor 4** (blobs.py 500→404 + multi-value ETag).

**Files:**
- Create: `backend/app/api/settings.py`, `backend/app/schemas/settings.py`, `backend/app/services/storage_probe.py`, `backend/app/tasks/migrate.py`, `backend/tests/test_settings_api.py`, `backend/tests/test_migrate_task.py`
- Modify: `backend/app/api/__init__.py` (mount settings router), `backend/app/tasks/celery_app.py` (imports), `backend/app/services/jobs.py` (retry branch for `migrate_storage`), `backend/app/api/blobs.py` (Minor 4 hardening), `backend/tests/test_blobs_api.py` (Minor 4 tests)

**Interfaces (Task 7 UI consumes these — keep exact):**
- `GET /api/settings/storage` → `StorageConfigOut { backend: str, config: dict }` where `config` is `redacted(...)` (secrets masked).
- `PUT /api/settings/storage` body `StorageConfigIn { backend, config }` → validates via `parse_storage_config({**config, "backend": backend})`, `set_active_config`, returns the redacted result. (Direct set — for pointing at an already-populated or empty backend; the safe copy path is `/migrate`.)
- `POST /api/settings/storage/test` body `StorageConfigIn` → builds a throwaway backend via `get_backend(settings, parsed)`, runs a probe (write `.tdmm-probe-<uuid>` tiny key → read back → delete), returns `ConnectionTestOut { ok: bool, detail: str, latency_ms: int }`. Never persists; never raises to the client on a backend error — a failed probe is `ok=false` with the error string in `detail`.
- `POST /api/settings/storage/migrate` body `StorageConfigIn` (target) → creates `Job(type="migrate_storage")`, dispatches `migrate_storage(job_id, target)`, returns `JobOut` (reuse the existing schema). Progress + terminal state surface through the existing jobs/SSE machinery.
- `app/tasks/migrate.py`:
  ```python
  @celery_app.task(name="app.tasks.migrate.migrate_storage")
  def migrate_storage(job_id: str, target: dict) -> None
  ```
  Copy library tree source→target, verify blake3 per file, then cutover the `storage` setting. **Never deletes the source** (Global Constraints: derivatives stay local; the source library is left for the operator to remove manually). Derivatives are NOT migrated (they're local).

- [ ] **Step 1 — probe service** `app/services/storage_probe.py`: `def probe_backend(backend: StorageBackend) -> tuple[bool, str, int]` — time a `write`/`read`/`delete` round-trip on a `.tdmm-probe-<uuid>` key under a scratch prefix; return `(ok, detail, latency_ms)`, catching every exception into `(False, str(exc), elapsed)`. Keep it tiny (a few bytes) so it works on a fresh empty backend.

- [ ] **Step 2 — failing settings-API tests** `tests/test_settings_api.py`: GET default returns `{"backend":"local","config":{...}}`; PUT an S3 config then GET returns it with `secret_key == "***"`; `POST /test` against a **local** candidate returns `ok=true`; `POST /test` against an S3 config pointing at a dead endpoint returns `ok=false` with a non-empty `detail` (no 500). `POST /migrate` returns a `JobOut` with `type=="migrate_storage"`. Run → RED.

- [ ] **Step 3 — implement the migrate task** `app/tasks/migrate.py`:
  ```python
  @celery_app.task(name="app.tasks.migrate.migrate_storage")
  def migrate_storage(job_id: str, target: dict) -> None:
      settings = get_settings()
      target_cfg = parse_storage_config(target)
      with base.sync_session() as s:
          jobs.mark_running(s, job_id)
          source = resolve_backend_sync(s, settings)
      dest = get_backend(settings, target_cfg)
      try:
          for entry in source.walk(""):
              # One streaming pass: hash the source bytes WHILE feeding them to
              # dest.write, then assert dest agrees. dest.write returns the
              # blake3 of what it actually wrote, so a single read verifies the
              # copy end-to-end (no second source read).
              src_hash = blake3.blake3()
              def _chunks():
                  for c in source.read(entry.key):
                      src_hash.update(c); yield c
              result = dest.write(entry.key, _chunks())
              if result.hash != src_hash.hexdigest():
                  raise RuntimeError(f"hash mismatch migrating {entry.key}")
          with base.sync_session() as s:
              set_active_config_sync(s, target_cfg)   # cutover only after every file verified
              jobs.mark_done(s, job_id)
      except Exception as exc:
          with base.sync_session() as s:
              jobs.mark_failed(s, job_id, str(exc))
          raise
  ```
  Add `"app.tasks.migrate"` to `celery_app.conf.imports`. `jobs.retry_job` gets a `"migrate_storage"` branch (re-dispatch with the same target — store the target in the job? the job row has no payload column; instead 409 "migrations are re-run from Settings, not retried" OR stash target in `report`... simplest: **no retry** — add a `migrate_storage` case that returns 409 "re-run the migration from Settings" via the default-unknown branch, and state that disposition in a comment). Prefer the 409 approach to avoid a payload-persistence detour.

- [ ] **Step 4 — implement the API** `app/api/settings.py` + `app/schemas/settings.py` per the interface block. `POST /test` builds the candidate backend with `get_backend(settings, parsed)` and calls `probe_backend` inside `anyio.to_thread.run_sync`. `POST /migrate` uses `jobs.create_job` + dispatch. Mount `settings.router` on `protected_router`.

- [ ] **Step 5 — migrate task test** `tests/test_migrate_task.py`: seed two files on a local source; PUT is not needed — call `migrate_storage` (eager) with a **second local dir** as the target (a `LocalConfig` can't point elsewhere, so use an S3 target against the MinIO fixture, or a temp-dir local variant); assert every key exists on the target with identical bytes AND the active config cut over to the target AND the source still has its files (never deleted). Using the `s3_backend`/MinIO fixture as the target is the realistic cross-backend migration test.

- [ ] **Step 6 — M2-Minor 4 fold** in `app/api/blobs.py`: where an `ok` derivative row's file is missing on disk, return a clean `404` (match the assembly-thumb route) instead of letting `FileResponse` 500 at send time; parse `If-None-Match` as a comma-separated list and strip weak `W/` prefixes before comparing to the computed ETag. Add tests to `tests/test_blobs_api.py`: missing-file-on-ok-derivative → 404; multi-value `If-None-Match` including the current ETag → 304.

- [ ] **Step 7 — run.** `uv run pytest tests/test_settings_api.py tests/test_migrate_task.py tests/test_blobs_api.py -v` → GREEN. Full suite green. Ruff clean.

- [ ] **Step 8 — commit.** `git add -A && git commit -m "Add storage settings API, connection test, and migration-helper job"`.

**Accept:** the active backend config is readable (secrets redacted) and settable; a connection test round-trips (or fails soft with a reason); a migration copies+verifies the library to a new backend and cuts over only after every file verifies, leaving the source intact; blob derivative 404s cleanly and honors multi-value ETags.

---

## Task 7: Settings page — storage backend config, connection test, migration (UI)

SPEC "Frontend" `/settings` row: "storage backend (local path / SMB host+share+creds / S3 endpoint+bucket+keys) + 'test connection'". Replaces the `ComingSoonPage` placeholder.

**Files:**
- Create: `web/src/pages/SettingsPage.tsx`, `web/src/api/settings.ts`, `web/src/components/settings/StorageBackendForm.tsx`
- Modify: `web/src/routes.tsx` (swap `settingsRoute.component`), `web/src/api/types.ts` (new section), `web/src/api/jobs.ts` (create — minimal `useJob(id)` poll for migrate progress; the file doesn't exist yet)

**Interfaces (mirror Task 6 exactly — hand-mirrored types, no codegen):**
```ts
// -- storage config (backend/app/schemas/settings.py) --
export type StorageScheme = "local" | "smb" | "s3";
export interface StorageConfigOut { backend: StorageScheme; config: Record<string, unknown>; }
export interface StorageConfigIn  { backend: StorageScheme; config: Record<string, unknown>; }
export interface ConnectionTestOut { ok: boolean; detail: string; latency_ms: number; }
// JobOut is already mirrored (types.ts:226-239) — reuse for the migrate job.
```

- [ ] **Step 1 — types + hooks.** Add the section above to `types.ts`. Create `web/src/api/settings.ts` following the `library.ts` template: `storageConfigQueryOptions` (`["settings","storage"]`), `useStorageConfig()`, `useUpdateStorageConfig()` (`api.put`… — note `client.ts` has no `put`; add a `put` method to `api` in `client.ts` mirroring `patch`, or use `api.post` if the endpoint is changed to POST — prefer adding `put` to the client, one line), `useTestConnection()` (`api.post("/settings/storage/test", body)`), `useMigrateStorage()` (`api.post("/settings/storage/migrate", body)` → returns `JobOut`). Create `web/src/api/jobs.ts` with `jobQueryOptions(id)` + `useJob(id, { enabled })` polling `GET /jobs?…`/`GET /jobs/{id}` (there's no single-job GET yet — reuse `GET /jobs` list filtered client-side, or add `GET /api/jobs/{id}` in Task 6; simplest: poll the list and find by id). Keep it minimal — this exists only to show migrate progress.

- [ ] **Step 2 — StorageBackendForm.** `web/src/components/settings/StorageBackendForm.tsx`: a `Select` for backend (`local`/`smb`/`s3`), then per-backend fields (SMB: host/share/root/username/password/port/encrypt; S3: bucket/access_key/secret_key/endpoint_url/region/prefix/addressing). Follow the `NewModelDialog` form pattern: controlled `useState` per field, inline `role="alert"` error, disabled-while-pending. Secret fields render as `<Input type="password" placeholder="••• (unchanged)"/>` and are only sent when non-empty (so a save that doesn't touch the secret keeps the stored one — the GET returns `"***"`, which the form treats as "leave unchanged"). Include the S3 lifecycle-rule note as help text: "Set a bucket lifecycle rule to expire incomplete multipart uploads." and the SMB IP/DNS note ("Use an IP or a resolvable DNS name; container needs `extra_hosts:` for LAN names").

- [ ] **Step 3 — SettingsPage.** `web/src/pages/SettingsPage.tsx` using shadcn `Tabs` (or `Card` sections): a **Storage** section showing the current backend (from `useStorageConfig`), the `StorageBackendForm`, a **Test connection** button (calls `useTestConnection` with the form's current values, shows the `ConnectionTestOut` result as a success/destructive line with `latency_ms`), and a **Migrate library to this backend** button gated behind `ConfirmDialog` ("Copies every library file to the new backend, verifies hashes, then switches over. The old library is left in place.") that fires `useMigrateStorage` and then shows the migrate job's progress via `useJob`. Loading/error/empty rendering per the `LibraryPage` convention.

- [ ] **Step 4 — route swap.** In `web/src/routes.tsx`, change `settingsRoute` to `component: SettingsPage` (import it), same pattern as `libraryRoute`.

- [ ] **Step 5 — tests** (Vitest + jsdom, `vi.mock("@/api/client")` via `vi.hoisted`, per `web/src/test/setup.ts` conventions): the form renders the right fields per selected backend; changing backend swaps fields; Test button calls `api.post("/settings/storage/test", ...)` and renders ok/fail; secret fields left blank aren't sent; Migrate button is confirm-gated and calls `/settings/storage/migrate`. Route-render test optional.

- [ ] **Step 6 — run.** `npm run build` (tsc strict) + `npm run lint` + `npm test` green.

- [ ] **Step 7 — commit.** `git add -A && git commit -m "Add Settings page: storage backend config, connection test, migration"`.

**Accept:** `/settings` shows the current backend, edits + tests a candidate config, and kicks off a verified migration with visible progress; secrets are never displayed and are preserved when left blank.

---

## Task 8: Scan report UI (trigger + adopt/relink/missing resolution) + frontend triage folds

SPEC "Frontend" `/settings` row: "scan trigger + last scan report (adopted/relinked/missing lists with resolve actions)". Report lives at **Settings → Storage** (design.md:170), so it extends the Task 7 page. Also folds **M2-Minor 1** (ViewerTab error boundary) and **M2-Minor 5** (UploadPage `seenTerminal` eviction).

**Files:**
- Create: `web/src/api/scan.ts`, `web/src/components/settings/ScanReport.tsx`
- Modify: `web/src/pages/SettingsPage.tsx` (add the Scan section), `web/src/api/types.ts` (scan types), `web/src/hooks/useEvents.tsx` (scan invalidation branch), `web/src/components/model-detail/ViewerTab.tsx` (error boundary), `web/src/pages/UploadPage.tsx` (seenTerminal eviction), plus the matching `*.test.tsx`

**Interfaces (mirror Task 5 exactly):**
```ts
// -- scan runs (backend/app/schemas/scan.py) --
export type ScanState = "queued" | "running" | "done" | "failed" | "skipped";
export interface ScanAdopted  { model_id: number; slug: string; revision_id: number; files: string[]; }
export interface ScanRelinked { file_id: number; from: string; to: string; hash: string; }
export interface ScanChanged  { file_id: number; storage_path: string; old_hash: string; new_hash: string; }
export interface ScanMissing  { file_id: number; storage_path: string; model_slug: string; }
export interface ScanReport   { adopted: ScanAdopted[]; relinked: ScanRelinked[]; changed: ScanChanged[]; missing: ScanMissing[]; verified: number; }
export interface ScanRunOut {
  id: number; created_at: string; finished_at: string | null; state: ScanState;
  files_seen: number; files_hashed: number; relinked: number; adopted: number;
  missing: number; report: ScanReport | null;
}
```

- [ ] **Step 1 — types + hooks.** Add the section above to `types.ts`. Create `web/src/api/scan.ts` (template = `library.ts`): `scanRunsQueryOptions` (`["scan","runs"]`), `useScanRuns()`, `useTriggerScan()` (`api.post("/scan")` → `ScanRunOut`; on success `invalidateQueries(["scan"])`).

- [ ] **Step 2 — ScanReport component.** `web/src/components/settings/ScanReport.tsx`: a **Run scan** button (`useTriggerScan`, disabled while the latest run is `queued`/`running`), a summary row of the latest run's counters (`files_seen/files_hashed/relinked/adopted/missing`, `Badge` for state), and three collapsible lists from `report`:
  - **Adopted** — each links to `/models/{slug}` (the draft is flagged review); the model page/gallery can show the `review_state` badge (surface `review_state` in `ModelSummary`/`ModelDetail` if cheap, else just link).
  - **Relinked** / **Changed** — informational rows (`from → to`, short hashes).
  - **Missing** — each row offers a resolve action: **Remove file record** (confirm-gated `DELETE /api/files/{id}` via the existing files hook — the backend `delete_file` tolerates the already-gone object) or leave it. This is the "missing resolution" the spec asks for, reusing the existing delete-file endpoint rather than inventing a resolution state machine.
  Loading/error/empty per the `LibraryPage` convention. Wire it into `SettingsPage` as a **Scan** section beneath Storage.

- [ ] **Step 3 — SSE invalidation.** In `web/src/hooks/useEvents.tsx` message handler: the event is still `job.updated`-shaped, so keep the existing branch; add — when `parsed.job_type === "scan_library"`, also `queryClient.invalidateQueries({ queryKey: ["scan"] })` (adopted models already refresh via the existing `["models"]`/`["revisions"]` invalidation). Update `useEvents.test.tsx` to assert the new invalidation fires for a `scan_library` event.

- [ ] **Step 4 — M2-Minor 1 fold.** `ViewerTab.tsx`: wrap the lazy `ModelViewer`/`useGLTF` render in a small error boundary (a class component or `react-error-boundary` if already a dep — otherwise a tiny local class) that renders a muted "Preview failed to load" card instead of propagating a GLB fetch/parse throw to the router error surface. Add a test that forces the boundary (make the lazy child throw) and asserts the card renders.

- [ ] **Step 5 — M2-Minor 5 fold.** `UploadPage.tsx`: evict entries from the `seenTerminal` ref-map once consumed (after applying a stored/failed terminal event to its item, `seenTerminal.current.delete(jobId)`), bounding growth over a long-lived tab. Adjust the existing UploadPage test if it asserts on the map.

- [ ] **Step 6 — run.** `npm run build` + `npm run lint` + `npm test` green. Record the `npm run build` bundle-size delta in the task report (ledger honesty on the deferred shadcn/bundle item — do not fix it here).

- [ ] **Step 7 — commit.** `git add -A && git commit -m "Add scan report UI (adopt/relink/missing resolution) + frontend triage folds"`.

**Accept:** Settings → Storage triggers a scan and shows the last run's counters + adopted/relinked/changed/missing lists; missing rows resolve via the existing delete-file action; a scan event live-refreshes the report; the viewer degrades gracefully on a bad GLB; UploadPage's terminal-event map no longer grows unbounded.

---

## Task 9: PUID/PGID privilege drop + optional beat + e2e + docs

Carried backlog "root containers → PUID/PGID in M3" (linuxserver.io convention). SPEC accept: "point library at a Samba share from the container with no privileged flags." Plus the SPEC M3 e2e drill and the optional scheduled scan's compose surface.

**Files:**
- Modify: `docker/Dockerfile` (gosu + base `tdmm` user), `docker/entrypoint.sh` (privilege drop), `compose.yaml` (PUID/PGID env passthrough + optional `beat` service), `.env.example` (document PUID/PGID/SMB/S3/scan), `README.md`, `backend/pyproject.toml` (e2e marker text if needed)
- Create: `backend/tests_e2e/test_m3_scan.py`

- [ ] **Step 1 — Dockerfile.** Add `gosu` and a base non-root user to the runtime stage: `RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*` (fold into the existing apt layer) and `RUN groupadd -g 1000 tdmm && useradd -u 1000 -g tdmm -M -s /usr/sbin/nologin tdmm`. Replace the "Runs as root (deliberate M1 choice)" comment with a note that root is still the default and PUID/PGID opt into dropping privileges.

- [ ] **Step 2 — entrypoint privilege drop.** At the top of `docker/entrypoint.sh`, before the `case`:
  ```bash
  # Optional privilege drop (linuxserver.io convention). Root is still the
  # default: set PUID/PGID to run the api/worker as a specific host uid/gid
  # so bind-mounted ./library files aren't root-owned. Re-exec guard avoids
  # an infinite loop.
  if [[ -z "${TDMM_PRIVDROP_DONE:-}" && ( -n "${PUID:-}" || -n "${PGID:-}" ) ]]; then
    PUID="${PUID:-1000}"; PGID="${PGID:-1000}"
    groupmod -o -g "$PGID" tdmm 2>/dev/null || groupadd -o -g "$PGID" tdmm
    usermod  -o -u "$PUID" -g "$PGID" tdmm 2>/dev/null || useradd -o -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin tdmm
    chown -R tdmm:tdmm /data /library 2>/dev/null || true
    export TDMM_PRIVDROP_DONE=1
    exec gosu tdmm:tdmm "$0" "$@"
  fi
  ```
  The re-exec falls through to the existing `case "${TDMM_ROLE}"` as the `tdmm` user. Migrations (`alembic upgrade head` in the api role) then run as `tdmm` — fine (DB creds are unaffected).

- [ ] **Step 3 — compose + env.** `compose.yaml`: add `PUID`/`PGID` to the `environment:` of `api`/`worker-io`/`worker-cpu` as `PUID: ${PUID:-}` / `PGID: ${PGID:-}` (empty → root, unchanged default). Add an **optional** `beat` service (commented or profile-gated, e.g. `profiles: ["beat"]`) running `celery -A app.tasks.celery_app beat` for the optional scheduled scan, sharing the image + env. `.env.example`: document `PUID`/`PGID` (commented, "set to your host uid/gid to avoid root-owned library files"), and add a **Storage backends** note that SMB/S3 config is set via the Settings UI (not env), plus the SMB `extra_hosts:` reminder and the scheduled-scan opt-in.

- [ ] **Step 4 — e2e (the SPEC drill).** `backend/tests_e2e/test_m3_scan.py` (httpx-only, style of `test_m1_flow.py`, marked `@pytest.mark.e2e`): login → create model → upload an STL → poll store+pipeline jobs done → **move the model's folder on the bind-mounted `./library`** (the e2e host has `./library` mounted; `os.rename` the `<slug>/` dir contents to a new top-level folder, or rename a rev dir) → `POST /api/scan` → poll the scan run to `done` → assert `relinked >= 1` (moved file relinked by hash) and the file is still downloadable with a verifying hash (`GET /api/files/{id}` bytes' blake3 == blob hash) → drop a fresh untracked folder of the STL bytes under `./library` → `POST /api/scan` → assert `adopted >= 1` and a new draft model appears in the gallery. This is exactly design.md:197's "upload → revision → move folder on share → rescan relinks → download verifies hash."

- [ ] **Step 5 — PUID/PGID smoke (cheap).** Add to `scripts/e2e.sh` (or document as a manual one-liner in README) a lightweight check: run the image with `-e PUID=1000 -e PGID=1000 -e TDMM_ROLE=api` overridden to `id -u` and assert it prints `1000` — proving the drop works without standing up the whole stack. Keep it optional/non-blocking if it complicates the compose run.

- [ ] **Step 6 — README.** Document: SMB/S3 backends configured in Settings (not env); the `local→X` migration helper; the scanner (adopt/relink/missing, never deletes); PUID/PGID usage; the optional `--profile beat` scheduled scan; SMB `extra_hosts:` for LAN DNS names.

- [ ] **Step 7 — run.** `scripts/e2e.sh` — M1 + M2 + the new M3 scan flow must pass. Fix what surfaces. `uv run pytest` (unit gate, `-m 'not e2e'`) still green. Ruff clean.

- [ ] **Step 8 — commit.** `git add -A && git commit -m "Add PUID/PGID privilege drop, optional scan schedule, M3 e2e, and docs"`.

**Accept (M3 gate, from SPEC):** the Samba share works unprivileged from the container (contract suite + real SMB); snapshot copy on SMB is server-side (COPYCHUNK); an out-of-band NAS folder is adopted as a draft model; a moved folder relinks by hash without re-hashing unchanged files; the container can run as a configured PUID/PGID.

---

## Self-Review (run against the SPEC after writing)

**1. Spec coverage.** Every M3 scope item maps to a task: SMB backend → T3; S3 backend → T4; registry/config pydantic-per-backend + settings-selected + "add a backend = one module + entry" → T1 (proven by T3/T4 each being exactly one module + one `@register`); connection-test endpoint → T6, UI → T7; local→X migration helper → T6 (job) + T7 (UI); `scan_library` + `scan_runs` report → T5; report UI adopt/relink/missing resolution → T8; optional scheduled scan → T5 (schedule) + T9 (compose); PUID/PGID → T9; contract suite parameterized over local/smb/s3 with dockerized Samba+MinIO → T2 (lands before T3/T4, which each flip their parameter green); scanner tests on local → T5; e2e drill → T9; Global Constraints (scanner never deletes, derivatives stay local, commit hygiene, version floors, real-infra tests) → header + enforced per task. All six M2 minors + the carried backlog have explicit dispositions in Global Constraints (fixed in a named task or wontfix with a one-line reason).

**2. Placeholder scan.** No "TBD"/"add error handling"/"similar to Task N"/"write tests for the above" — every code step carries real code; every test step names concrete assertions; the two spec-underspecified surfaces (connection-test + migration endpoint verbs/paths) are pinned in Global Constraints and Task 6.

**3. Type consistency.** `StorageConfig`/`LocalConfig`/`SmbConfig`/`S3Config` and `parse_storage_config`/`redacted` are defined in T1 and used verbatim in T2 (fixtures), T3/T4 (factories), T5 (scanner scheme check), T6 (settings API + migrate). `get_backend(settings, config)` signature is set in T1 and called that way everywhere after. `resolve_backend`/`resolve_backend_sync` names are stable across T1 (deps + ingest/pipeline), T5 (scan task), T6 (migrate task). `ScanRunOut` + report JSONB shape defined in T5 and mirrored field-for-field in T8's `types.ts`. `SmbStorageBackend(config)`/`S3StorageBackend(config)` constructors match their fixtures in T2. `EntryInfo`/`StatResult`/`WriteResult` are the frozen protocol dataclasses used unchanged. `publish_scan_event_sync` (T5) reuses the `job.updated` shape the T8 `useEvents` branch keys on.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-06-m3-storage-scanner.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
