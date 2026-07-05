# M1 Implementation Plan — Core Library on Local Storage

Executes milestone M1 of the approved design (`docs/superpowers/specs/2026-07-04-3d-model-manager-design.md`, referred to as SPEC). Read the SPEC section named in each task before implementing.

## Global Constraints (bind every task)

- **Git identity:** commits are authored by the repo-local git config (`metril <1517921+metril@users.noreply.github.com>`). NEVER add `Co-Authored-By`, "Generated with", or any AI-attribution lines to commits.
- **Branch:** all M1 work happens on `feat/m1-core-library`.
- **Backend:** Python 3.12, managed with `uv` in `backend/` (`uv sync`, `uv run`). Package layout `backend/app/...`, tests in `backend/tests/`. FastAPI app importable as `app.main:app`. All routes under `/api`. Config via pydantic-settings, env prefix `TDMM_` (e.g. `TDMM_DATABASE_URL`, `TDMM_REDIS_URL`, `TDMM_DATA_DIR`, `TDMM_LIBRARY_ROOT`, `TDMM_SECRET_KEY`, `TDMM_ADMIN_USERNAME`, `TDMM_ADMIN_PASSWORD`).
- **Quality gates (backend):** `uv run ruff check .` and `uv run ruff format --check .` clean; `uv run pytest` green with pristine output. Full type hints on public functions; no mypy gate in M1.
- **DB:** SQLAlchemy 2 async + asyncpg + Alembic. All enums as `sa.Enum(..., native_enum=False)` backed by Python `StrEnum`. Naming-convention metadata for constraints. Tests run against REAL PostgreSQL via `testcontainers` (docker is available) — never mock the DB or use SQLite substitutes.
- **Frontend:** `web/` — Vite 8, React 19.2, TypeScript strict, Tailwind 4 via `@tailwindcss/vite` (CSS-first, no tailwind.config), shadcn CLI with **`-b radix`**, TanStack Query 5 + TanStack Router, npm. Quality gates: `npm run build` (tsc + vite) passes; `npm run lint` clean if lint configured by scaffold.
- **Storage keys** are POSIX relative paths from the library root. Library layout is EXACTLY SPEC "Path layout": `<slug>/rev-{number:03d}_{slugified-name}/<rel_path>` plus `<slug>/.3dmm.json` sidecar `{"model_id": ..., "slug": ..., "name": ...}`. Derivatives NEVER go in the library tree.
- **Revision mutability rule:** files may be added/replaced/deleted only on a model's CURRENT (latest) revision; older revisions are immutable snapshots. Creating revision N+1 full-snapshot-copies revision N via `backend.copy()` (no re-hash; reuse blob hashes), then applies staged ops.
- **Pagination:** cursor-based — request `?limit=&cursor=`; response `{"items": [...], "next_cursor": "..."|null}`. Cursor = urlsafe-base64 of `"{updated_at.isoformat()}|{id}"`.
- **Auth:** every `/api` route except `/api/auth/login` and `/api/health` requires a valid session cookie `tdmm_session` (HttpOnly, SameSite=Lax; `secure` from settings, default false). 30-day expiry.
- **Events:** SSE at `GET /api/events`; server publishes JSON events to Redis pub/sub channel `tdmm:events`; event shape `{"type": "job.updated", "job_id": "...", "job_type": "...", "state": "...", "subject_type": "...", "subject_id": ...}`.
- **TDD:** required for all backend logic tasks (2–6): write the failing test first, keep RED/GREEN evidence in your report.

---

## Task 1: Backend scaffold, config, health endpoint, tooling

SPEC: "Architecture" (api service). Create the uv-managed backend project.

- `backend/pyproject.toml`: project `tdmm`, `requires-python = ">=3.12"`, deps: `fastapi`, `uvicorn[standard]`, `pydantic-settings`, `sqlalchemy[asyncio]`, `asyncpg`, `alembic`, `redis`, `celery`, `blake3`, `argon2-cffi`, `python-slugify`, `anyio`. Dev deps: `pytest`, `pytest-asyncio`, `httpx`, `ruff`, `testcontainers[postgres]`. Add `[tool.ruff]` (line-length 100, target py312, lint select `E,F,I,UP,B,SIM`), `[tool.pytest.ini_options]` (`asyncio_mode = "auto"`).
- `uv python pin 3.12` (backend/.python-version), `uv sync`.
- `backend/app/config.py`: `Settings(BaseSettings)` with env prefix `TDMM_`: `database_url` (default `postgresql+asyncpg://tdmm:tdmm@localhost:5432/tdmm`), `redis_url` (default `redis://localhost:6379/0`), `data_dir: Path` (default `./data`), `library_root: Path` (default `./library`), `secret_key: str` (default `"dev-insecure"`), `admin_username` (default `admin`), `admin_password: str | None`, `cookie_secure: bool = False`. Cached `get_settings()`.
- `backend/app/main.py`: `create_app()` factory; mounts `/api` router; `GET /api/health` → `{"status": "ok"}` (no auth); CORS not needed (same-origin).
- Structured logging setup (stdlib logging, uvicorn-compatible).
- Tests: `backend/tests/test_health.py` via `httpx.AsyncClient`/ASGITransport.
- Commit.

Accept: `uv run pytest` green; `uv run ruff check .` clean; `uv run uvicorn app.main:app` serves `/api/health`.

## Task 2: Full data model + Alembic baseline + test infrastructure

SPEC: "Data model" — implement EVERY table exactly as listed there (users, sessions, models, tags, model_tags, notes, revisions, blobs, files, blob_meta, derivatives, assembly_thumbs, printers, print_jobs, imports, jobs, scan_runs, settings), including uniques, FKs, and the indexes: `files(blob_hash)`, `files(storage_path)`, pg_trgm GIN on `models.name` + `models.description`, `print_jobs(state)`.

- `backend/app/db.py`: async engine/session factory, `get_db` dependency.
- `backend/app/models/` package: SQLAlchemy models split by domain (`auth.py`, `library.py`, `processing.py`, `printing.py`, `system.py`), shared `Base` with naming conventions in `models/base.py`. StrEnum types in `backend/app/models/enums.py`.
- Alembic: `backend/alembic/` async template; ONE baseline migration creating everything incl. `CREATE EXTENSION IF NOT EXISTS pg_trgm` and the GIN indexes.
- `backend/tests/conftest.py`: session-scoped Postgres testcontainer; apply migrations via Alembic (this validates the migration itself); function-scoped async session with truncate-between-tests; app fixture wired to the container DB.
- Tests: migration applies cleanly; round-trip insert of model→revision→blob→file; `UNIQUE(model_id, number)` and `UNIQUE(revision_id, rel_path)` enforced; enums reject bad values.
- Commit.

## Task 3: Auth — single admin login, sessions, first-run bootstrap

SPEC: requirement 1 and "API surface" auth rows.

- `backend/app/security.py`: argon2id hash/verify (argon2-cffi defaults).
- `backend/app/api/auth.py`: `POST /api/auth/login` {username,password} → 204 + `tdmm_session` cookie (uuid4 session row, 30-day expiry, update `last_seen_at` on use); `POST /api/auth/logout` → delete session + clear cookie; `GET /api/auth/me` → {username}.
- `backend/app/api/deps.py`: `require_session` dependency (403 without valid cookie); wire into the api router so ALL routes except login/health require it (routers composed with the dependency, not per-endpoint copy-paste).
- Startup bootstrap: if no user exists, create admin from `TDMM_ADMIN_USERNAME`/`TDMM_ADMIN_PASSWORD`; if password unset, generate a random one and log it ONCE at WARNING level.
- Tests: login wrong/right, cookie set flags, expired session rejected, logout invalidates, bootstrap creates exactly one user (idempotent on restart), protected route 403s.
- Commit.

## Task 4: StorageBackend protocol + local backend + registry

SPEC: "Storage layer". Modules: `backend/app/storage/base.py` (Protocol + `WriteResult(hash: str, size: int)` + `EntryInfo(key, size, mtime)` + `StatResult(size, mtime)` dataclasses + typed errors in `storage/errors.py`: `StorageKeyNotFound`, `StorageError`), `storage/local.py`, `storage/registry.py`.

- Protocol methods exactly: `write(key, chunks: Iterable[bytes]) -> WriteResult` (blake3 teed during write; atomic: temp file in same dir + `os.replace`), `read(key, start=0, end=None) -> Iterator[bytes]` (1 MiB chunks), `copy(src, dst)`, `move(src, dst)`, `delete(key)`, `exists(key)`, `stat(key)`, `walk(prefix="") -> Iterator[EntryInfo]` (os.scandir recursion), `mkdirs(key_prefix)`.
- Local `copy()`: try `fcntl.ioctl(dst_fd, fcntl.FICLONE, src_fd)` for reflink; on `OSError` fall back to `shutil.copyfile`. Both paths atomic (clone/copy to temp then replace).
- Key safety: reject absolute keys or `..` traversal (`StorageError`).
- `registry.py`: `register(scheme)` decorator + `get_backend(settings) -> StorageBackend`; M1 wires only `local` from `TDMM_LIBRARY_ROOT` (env-only; DB-settings wiring arrives in M3 — leave a code comment referencing SPEC M3).
- All sync; API layers must call via `anyio.to_thread.run_sync` (document in base.py docstring).
- Tests (tmp_path): write→read round-trip + correct blake3 (verify against `blake3` lib direct hash); atomicity — kill the chunk iterator mid-write (raise inside generator) and assert no partial final file exists; copy produces identical bytes (and exercise the fallback path by patching `fcntl.ioctl` to raise); walk lists nested entries with correct sizes; traversal keys rejected; move/delete/exists/stat behave.
- Commit.

## Task 5: Library domain — models/revisions/files/tags/notes CRUD + layout writer

SPEC: "Data model", "Storage layer" (path layout, new revision), "API surface". Modules: `backend/app/services/library.py` (domain logic), `backend/app/services/layout.py` (slug + dir-name + sidecar writer), `backend/app/api/{models,revisions,tags,notes}.py`, `backend/app/schemas/` (pydantic response/request models).

- `POST /api/models` {name, description?} → slug via python-slugify, uniquified with `-2`, `-3`...; creates model + revision 1 (`number=1`, `name="initial"`, `dir_name="rev-001_initial"`), `current_revision_id` set; `mkdirs` the revision dir; write `.3dmm.json` sidecar via backend.
- `GET /api/models` gallery query: `q` (ILIKE on name/description — trigram index supports it), `tag`, `format` (join files→blobs of current revision), `sort` (`updated_at` default desc, `name`), cursor pagination per Global Constraints.
- `GET /api/models/{slug}` → model + tags + current revision incl. files with blob info. `PATCH` (name does NOT change slug/dirs in M1; description, cover). `DELETE` → sets `is_archived=true` (hard delete out of M1 scope; archived models excluded from gallery by default, `?archived=true` to include).
- Revisions: `GET /api/models/{id}/revisions`; `POST /api/models/{id}/revisions` {name?, note?} → next number, dir_name `rev-{n:03d}_{slugified-name-or-'rev'}`, full-snapshot copy of current revision's files via `backend.copy` (reuse blob_hash — NO re-hash), sets current_revision_id; `GET /api/revisions/{id}` (files + blob meta); `GET /api/revisions/{a}/diff/{b}` → `{added: [...], removed: [...], changed: [...], unchanged: [...]}` by full outer join on rel_path comparing blob_hash.
- File ops on CURRENT revision only (409 otherwise): `DELETE /api/files/{id}` removes file row + backend file.
- Tags: `GET /api/tags`; `POST /api/models/{id}/tags` {name} (get-or-create); `DELETE /api/models/{id}/tags/{name}`.
- Notes: `POST /api/notes` {model_id, revision_id?, body}; `PATCH/DELETE /api/notes/{id}`; included in model/revision GETs.
- Tests (API-level, real PG + tmp local backend): slug collision, gallery filters/pagination/search, revision snapshot creates full copy on disk (assert files exist in new rev dir) and diff reports unchanged/changed correctly after a file replace, immutability 409, archive behavior, notes/tags round-trip.
- Commit.

## Task 6: Upload/download, Celery + jobs tracking, SSE events

SPEC: "Upload flow", "Processing pipeline" (jobs table + store_to_backend only — extraction jobs are M2), "API surface". Modules: `backend/app/api/{uploads,files,events,jobs}.py`, `backend/app/tasks/{celery_app,ingest}.py`, `backend/app/services/{spool,events,jobs}.py`.

- `PUT /api/uploads?model_id=&revision_id=&rel_path=`: raw streaming body (`request.stream()`, ~1 MiB chunks) teed to blake3 + `{data_dir}/spool/{uuid}`; validates revision is current + rel_path free (409 conflict → replace requires `?replace=true`); on completion: upsert blob (dedupe by hash; format/kind inferred from extension per SPEC enums), create/replace file row (`storage_path` = layout path), enqueue `store_to_backend(file_id, spool_path)`; response `{file_id, blob_hash, size, job_id}`.
- `store_to_backend` Celery task: streams spool → `backend.write` (verify returned hash matches; mismatch → job failed), sets `files.mtime`/`verified_at`, deletes spool file, publishes job events. Celery app: broker/result from `TDMM_REDIS_URL`, task_routes default queue `io`, `task_acks_late=True`.
- Jobs service: create `jobs` row on enqueue, transition running/done/failed inside task (SQLAlchemy sync session for worker or async→sync bridge — worker uses its own sync engine (psycopg? No: use `sqlalchemy` sync with `postgresql+psycopg` would add a dep; instead run async engine via `asyncio.run` inside task functions — pick ONE approach, document it, keep it contained in `tasks/base.py`).
- `GET /api/jobs?state=`, `POST /api/jobs/{id}/retry` (re-enqueues store_to_backend if its spool file still exists, else 409).
- `GET /api/files/{id}/download`: StreamingResponse from `backend.read` via threadpool generator, `Content-Disposition` original filename, correct length.
- SSE `GET /api/events`: async Redis pub/sub subscription on `tdmm:events`, heartbeat comment every 15s; events per Global Constraints.
- Tests: Celery in eager mode for API tests — upload → blob/file rows + spool gone + file present at correct layout path + hash verified; duplicate-content upload reuses blob; replace flow; download streams identical bytes; jobs transition + retry; SSE endpoint yields a published event (fakeredis NOT allowed — use a redis testcontainer, session-scoped).
- Commit.

## Task 7: Frontend scaffold — Vite 8, React 19, Tailwind 4, shadcn(radix), router, auth

SPEC: "Frontend" (stack pins). In `web/`:

- Scaffold: `npm create vite@latest` (react-ts), React 19.2, TS strict; Tailwind 4 via `@tailwindcss/vite` + `@import "tailwindcss"` in `src/index.css`; shadcn: `npx shadcn@latest init -b radix` (pin the flag) + add `button card input dialog dropdown-menu badge tabs textarea sonner skeleton`; TanStack Router (code-based routes in `src/routes.tsx`) + TanStack Query 5 with a `src/api/client.ts` fetch wrapper (base `/api`, credentials include, JSON errors typed `{detail}`; 401 → redirect to /login — auth returns 401 + `WWW-Authenticate: Cookie`, an authorized deviation from the original 403).
- Vite dev proxy: `/api` → `http://localhost:8080`.
- App shell: sidebar nav (Library, Upload, Import, Printer, Jobs, Settings — unstubbed ones render "coming in M2+" placeholders), dark/light via `prefers-color-scheme` + toggle persisting to localStorage (class strategy on `<html>`).
- `/login` page → `POST /auth/login`; auth guard redirects unauthenticated; `GET /auth/me` bootstraps.
- Quality: `npm run build` green (tsc strict); add `vitest` + one smoke test rendering the login page (jsdom).
- Commit. (Do not integrate with Docker yet — Task 9.)

## Task 8: Frontend core pages — Gallery, Model detail, Upload

SPEC: "Frontend" routes table (gallery/detail/upload rows only; no 3D viewer — that is M2; show a placeholder panel where the viewer tab will live).

- **Gallery `/`**: responsive card grid; placeholder thumb = format icon + first letters (blob thumbnails arrive in M2 — render `<img>` with fallback so M2 endpoints slot in); name, tag chips, format badges; debounced search box (300ms), tag + format filter sidebar, sort select; `useInfiniteQuery` with the cursor API; empty state.
- **Model detail `/models/$slug`**: header (name, description edit-in-place, tags add/remove, archive button); tabs: **Files** (table: rel_path, size, hash short, mtime, download button, delete-on-current-revision), **3D View** (placeholder card "viewer arrives in M2"), **Revisions** (timeline list; revision→revision diff view rendering added/removed/changed/unchanged rows with badges; "New revision" dialog {name, note} calling POST), **Notes** (markdown textarea + rendered list via a tiny md renderer — use `marked` + sanitize, model-level and per-revision).
- **Upload `/upload`**: target picker (new model {name} | existing model via search select → uploads go to its current revision); drag-drop + file picker, multi-file queue; per-file progress via `XMLHttpRequest` PUT (fetch has no upload progress); rel_path defaults to filename (subdirs preserved when dropping folders if trivially supported — else filename only); after upload, job status chip driven by SSE (`EventSource('/api/events')` singleton hook `useEvents()` updating a Query cache).
- Types for all API payloads in `src/api/types.ts` matching backend schemas.
- Quality: build green; vitest smoke tests for gallery card + diff badge rendering.
- Commit.

## Task 9: Integration — Docker image, compose, SPA serving, E2E verification

SPEC: "Architecture" table + M1 acceptance criteria.

- `docker/Dockerfile`: stage 1 node:24-slim builds `web/` → stage 2 `python:3.12-slim` + uv (copy from `ghcr.io/astral-sh/uv`), `uv sync --frozen --no-dev`, copy `backend/`, copy web dist to `/app/static`; entrypoint script switching on `TDMM_ROLE` (api → alembic upgrade head + uvicorn; worker → celery worker -Q io,cpu).
- FastAPI serves SPA: mount static with SPA fallback (non-`/api` 404s → index.html).
- `compose.yaml` (repo root): services api (ports 8080, TDMM_ROLE=api), worker, db (postgres:16-alpine, healthcheck), redis (redis:7-alpine); volumes `pgdata`, `tdmm_data`; bind `./library:/library`; `.env.example` with all TDMM_ vars documented; api/worker depend_on healthy db+redis.
- E2E script `scripts/e2e-m1.sh`: compose up --build -d; wait for health; then run `backend/tests_e2e/test_m1_flow.py` (pytest, marked `e2e`, hits http://localhost:8080) — login (password from env), create model, generate + upload a ~1 MB procedurally-generated binary STL (cube grid — write generator in the test), poll job done, assert file exists under `./library/<slug>/rev-001_initial/`, create revision 2, assert full snapshot on disk, diff shows all-unchanged, replace one file in rev-2 then diff shows 1 changed, download and blake3-verify, `docker compose restart api` then relogin+list still works.
- Update README quickstart (compose up, first-run admin password note).
- Fix anything the E2E surfaces. Commit.

Accept (M1 gate, from SPEC): upload with progress; near-instant rev-2 snapshot (reflink where supported); hash-diff correct; on-disk tree matches layout spec exactly; restart-safe.
