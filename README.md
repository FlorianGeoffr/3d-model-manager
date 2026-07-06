# 3D Model Manager

Self-hosted web app for managing a personal library of 3D-printable models.

- **Library**: STL, 3MF (incl. Bambu Production Extension), OBJ, STEP, IGES, plus sliced `.gcode.3mf`/`.gcode` artifacts
- **Storage**: pluggable backends — local directory, SMB share (userspace client, no privileged container), S3 — human-readable tree, every file content-hashed (blake3)
- **Revisions**: model-level, full snapshot per revision (fast-copied via reflink / SMB COPYCHUNK / S3 CopyObject), hash-diff between revisions
- **Viewing**: server-side normalization to meshopt-compressed GLB; in-browser rotate/zoom/pan viewer; server-rendered thumbnails (f3d) + embedded 3MF plate thumbnails
- **Printing**: send sliced files to a Bambu Lab A1 mini over LAN (Developer Mode: FTPS upload + MQTT start/status)
- **Import**: by URL from Printables, Thingiverse, and (feature-flagged) MakerWorld, with provenance/license capture
- **Stack**: FastAPI + Celery/Redis + PostgreSQL backend; React 19 + Vite + Tailwind 4 + shadcn/Radix frontend; Docker Compose deployment
- **Processing pipeline**: per-blob background jobs extract mesh/CAD metadata (dims, triangle count, volume) and sliced-file metadata (print time, filament, per-plate previews), convert STL/OBJ/3MF/STEP/IGES to GLB, meshopt-compress it for the browser (`gltfpack`), and render server-side thumbnails (`f3d`) -- covering plain meshes, CAD (via OCCT), and Bambu Production-Extension/sliced `.gcode.3mf` 3MFs
- **Viewer**: in-browser React Three Fiber viewer (orbit/pan/zoom) rendering the compressed GLB, with an automatic decimated LOD for very high-poly meshes
- **Gallery**: cover thumbnails, per-format badges, sliced-file filtering (`has_sliced`) and print-time display, driven by the same processing pipeline

Design spec: [docs/superpowers/specs/2026-07-04-3d-model-manager-design.md](docs/superpowers/specs/2026-07-04-3d-model-manager-design.md)
Research notes: [docs/research/](docs/research/)

## Status

Pre-alpha — under active development. See the spec for the M0–M6 milestone plan.

## Quickstart (Docker Compose)

Requires Docker with the Compose plugin.

```sh
cp .env.example .env
docker compose up -d --build
```

This starts five services: `api` (port `8080`), `worker-io` (uploads/store),
`worker-cpu` (the metadata/GLB-conversion/thumbnail pipeline, one process per
core, memory-recycled -- see "Worker split" below), `db` (Postgres 16), and
`redis`. The api container runs Alembic migrations on startup, then serves
both the JSON API (`/api/...`) and the built frontend SPA at
<http://localhost:8080>.

Models and files are written to `./library` on the host (bind-mounted); job
spool state and other app data live in the `tdmm_data` named volume.

**First-run admin password**: if `TDMM_ADMIN_PASSWORD` is left unset in
`.env`, the api container generates a random password on first boot and
prints it exactly once, at `WARNING` level, to its logs:

```sh
docker compose logs api | grep -i password
```

Copy it down immediately — it is not recoverable afterwards (short of
resetting the `db` volume). To pin a known password instead (e.g. for
scripting), set `TDMM_ADMIN_PASSWORD` in `.env` before the first `up`.

To tear the stack down (keeping data): `docker compose down`. To also drop
the database/volumes: `docker compose down --volumes`.

**Worker split**: the processing pipeline's CPU-heavy steps (metadata
extraction, GLB conversion via OCCT/trimesh/lib3mf, `gltfpack` optimization,
`f3d` thumbnail rendering) run on `worker-cpu`, routed there by queue name;
everything else (`store_to_backend`, the upload path) runs on `worker-io`.
`worker-cpu` runs one process per core with no fixed concurrency, and
recycles each child process after 16 tasks or 1.5 GiB RSS, whichever comes
first, to contain memory growth from OCCT (STEP/IGES) and f3d. Both workers
expose a `celery inspect ping` healthcheck.

## Development

### Backend

```sh
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8080
```

Requires a Postgres and Redis reachable at the `TDMM_DATABASE_URL` /
`TDMM_REDIS_URL` defaults (`localhost:5432` / `localhost:6379`) — the
easiest way is `docker compose up -d db redis`. Run the Celery worker
alongside the api for upload/ingest and pipeline processing:

```sh
uv run celery -A app.tasks.celery_app worker -Q io,cpu --concurrency=2 -l info
```

**M2 pipeline prerequisites**: run `scripts/fetch-gltfpack.sh` once (fetches
the `gltfpack` CLI, used by the `optimize_glb` step, into `backend/.tools/`
via npm — outside the uv-managed Python dependencies). `f3d` thumbnail
rendering needs no extra install for local dev: it falls back to Mesa's EGL
offscreen renderer automatically when OSMesa isn't available. `libosmesa6`
is only installed inside the Docker image, for that GPU-less container's
OSMesa path.

Tests (real Postgres + Redis via `testcontainers`, no mocks):

```sh
uv run pytest        # unit/integration suite (e2e excluded via the `e2e` marker)
uv run ruff check .
uv run ruff format --check .
```

The full Docker-based end-to-end flow (build image, run compose stack, drive
the M1 upload/revision/diff/download/restart flow plus the M2
metadata/GLB/thumbnail pipeline flow over HTTP) lives in `backend/tests_e2e/`
and runs via:

```sh
scripts/e2e.sh
```

### Frontend

```sh
cd web
npm install
npm run dev
```

Vite's dev server proxies `/api` to `http://localhost:8080`, so run the
backend (or `docker compose up -d api db redis worker-io worker-cpu`)
alongside it.

```sh
npm run build   # tsc --build + vite build, output to web/dist
npm run test    # vitest
```
