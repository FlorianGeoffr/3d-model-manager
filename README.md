# 3D Model Manager

Self-hosted web app for managing a personal library of 3D-printable models.

- **Library**: STL, 3MF (incl. Bambu Production Extension), OBJ, STEP, IGES, plus sliced `.gcode.3mf`/`.gcode` artifacts
- **Storage**: pluggable backends — local directory, SMB share (userspace client, no privileged container), S3 — human-readable tree, every file content-hashed (blake3)
- **Revisions**: model-level, full snapshot per revision (fast-copied via reflink / SMB COPYCHUNK / S3 CopyObject), hash-diff between revisions
- **Viewing**: server-side normalization to meshopt-compressed GLB; in-browser rotate/zoom/pan viewer; server-rendered thumbnails (f3d) + embedded 3MF plate thumbnails
- **Printing**: send sliced files to a Bambu Lab A1 mini over LAN (Developer Mode: FTPS upload + MQTT start/status)
- **Import**: by URL from Printables, Thingiverse, and (feature-flagged) MakerWorld, with provenance/license capture
- **Stack**: FastAPI + Celery/Redis + PostgreSQL backend; React 19 + Vite + Tailwind 4 + shadcn/Radix frontend; Docker Compose deployment

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

This starts four services: `api` (port `8080`), `worker`, `db` (Postgres 16),
and `redis`. The api container runs Alembic migrations on startup, then
serves both the JSON API (`/api/...`) and the built frontend SPA at
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
alongside the api for upload/ingest processing:

```sh
uv run celery -A app.tasks.celery_app worker -Q io,cpu --concurrency=2 -l info
```

Tests (real Postgres + Redis via `testcontainers`, no mocks):

```sh
uv run pytest        # unit/integration suite (e2e excluded via the `e2e` marker)
uv run ruff check .
uv run ruff format --check .
```

The full Docker-based end-to-end flow (build image, run compose stack,
drive upload/revision/diff/download/restart over HTTP) lives in
`backend/tests_e2e/` and runs via:

```sh
scripts/e2e-m1.sh
```

### Frontend

```sh
cd web
npm install
npm run dev
```

Vite's dev server proxies `/api` to `http://localhost:8080`, so run the
backend (or `docker compose up -d api db redis worker`) alongside it.

```sh
npm run build   # tsc --build + vite build, output to web/dist
npm run test    # vitest
```
