# 3D Model Manager

Self-hosted web app for managing a personal library of 3D-printable models.

- **Library**: STL, 3MF (incl. Bambu Production Extension), OBJ, STEP, IGES, plus sliced `.gcode.3mf`/`.gcode` artifacts
- **Storage**: pluggable backends — local directory, SMB share (userspace client, no privileged container), S3 — human-readable tree, every file content-hashed (blake3); configured/connection-tested from Settings, with a local→X migration helper
- **Scanner**: `scan_library` reconciles the DB against the backend on demand (or on a schedule) — relinks moved folders by hash without re-hashing untouched files, adopts out-of-band folders dropped straight onto the share as draft models, flags genuinely missing files for review; never deletes anything
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

**Running as a non-root user (PUID/PGID)**: by default the api/worker
containers run as root, so files written under the bind-mounted `./library`
end up root-owned on the host. Set `PUID`/`PGID` in `.env` (e.g. to your
`id -u`/`id -g`) to have the entrypoint drop privileges to that uid/gid
instead (linuxserver.io convention) — it also `chown`s the existing
`./library`/`tdmm_data` contents to match on every start, so this is safe to
turn on after the fact. Verify the drop works without standing up the whole
stack:

```sh
docker build -f docker/Dockerfile -t tdmm:local .
docker run --rm -e PUID=1000 -e PGID=1000 -e TDMM_ROLE=api tdmm:local id -u
# -> 1000
```

## Storage backends & the scanner

The active storage backend (local directory, SMB, or S3 — exactly one at a
time) is chosen and configured from **Settings → Storage** in the running
app, not via `.env`: each backend's connection details (SMB host/share/
credentials, S3 bucket/keys/endpoint) are validated, connection-tested
before they take effect, and stored in the database. Switching backends
offers a **local→X migration** job that copies existing content over before
the switch flips live.

**SMB**: address the NAS by IP or a real, resolvable DNS name — never a bare
mDNS/`.local`/NetBIOS name, which the container's resolver can't see. For a
LAN-only DNS name, add an `extra_hosts:` entry for it to the `api`/
`worker-io`/`worker-cpu` services in `compose.yaml`:

```yaml
    extra_hosts:
      - "nas.lan:192.168.1.50"
```

**Rescan/reconcile**: trigger a scan from Settings → Storage (or `POST
/api/scan`) to reconcile the database against whatever is actually on the
backend — useful after reorganizing files directly on a share/NAS outside
the app. A scan relinks moved folders by hash (without re-hashing files
that didn't move), adopts folders dropped straight onto the share as new
draft models for review, and flags files present in the database but
missing on disk for a human to resolve. It never deletes library content or
database rows. To run scans automatically on a schedule instead of only
on demand, set `TDMM_SCAN_INTERVAL_S` (seconds) in `.env` and start the
optional `beat` service: `docker compose --profile beat up -d`.

## Printer integration (Bambu LAN, feature-flagged)

**Off by default.** Enable it by setting `TDMM_PRINTER_ENABLED=true` in
`.env` **and** starting the printer daemon with `docker compose --profile
printer up -d` (a plain `up` never starts `printerd`) — both are required.
With the flag off (the default), the app is fully usable: the printers API
503s and the Printer nav hides.

**Printer prerequisites**: an A1/A1 mini on firmware **≥ 01.05.00.00**. On
the printer's screen, enable **LAN-only Mode**, power-cycle it, then enable
**Developer Mode** in the same menu; the **access code** shows on the
LAN-only screen (toggle LAN-only off and back on if it displays zeros). A
healthy **microSD card is mandatory** — without one, uploads fail with an
"Insert SD card" error. Pin the firmware version that's known to work for
you, and re-verify connectivity after every firmware update using the
setup wizard's **Test connection** (an MQTT connect + `pushall` probe).

**Tradeoff**: Developer Mode requires LAN-only Mode, which disconnects the
printer from **Bambu Cloud and the Bambu Handy app**. Deliver firmware
updates via microSD instead, or temporarily re-enable cloud connectivity
when you need one.

**ToS / responsibility**: LAN Developer Mode is a user-enabled,
**Bambu-unsupported** escape hatch — enabling it is your decision and your
responsibility. This app never uses the Bambu Connect signed cloud path.

**Security**: the printer's access code is stored **Fernet-encrypted**
(`printers.access_code_enc`) using a key at `${TDMM_DATA_DIR}/secrets/
printer.key` (mode `0600`, auto-generated and shared across api/worker/
printerd via the `tdmm_data` volume) or supplied explicitly via
`TDMM_PRINTER_KEY`. It is decrypted only inside the worker/printerd
processes, and is never returned by the API or written to logs. **TLS
verification is off in v1**: the printer's MQTT/FTPS/camera ports present a
self-signed certificate from Bambu's private CA that no system trust store
accepts (and there's no hostname to check against), so — like every other
LAN client — this app disables verification rather than trusting nothing. A
**TOFU (trust-on-first-use) certificate pin is deferred to M6** hardening.

**Sending**: only sliced **`.gcode.3mf`** files (Bambu Studio's "Export
plate sliced file") can be sent to a printer — a bare `.gcode` is rejected.
A print won't start unless the printer is idle (state ∈ `IDLE`/`FINISH`/
`FAILED`); a printer that's busy, offline, or of unknown state is rejected
before anything is uploaded.

Register a printer from **Settings → Printer** (host, serial, access code)
— the setup wizard runs **Test connection** against it before saving.

### Manual/Live Acceptance (deferred — user present, real A1 mini, NOT automated)

The physical "the A1 mini actually starts printing" drill needs a real
printer on the LAN and a person watching the first print start, so it is
**not** part of the automated test suite (see `backend/tests_e2e/
test_m4_printer.py` for the hardware-free flag-off/wizard/preflight
coverage that *is* automated). When hardware is available, run this once
against a real A1 mini:

1. On the printer: firmware ≥ 01.05, enable **LAN-only Mode** → power-cycle
   → enable **Developer Mode**; note the access code.
2. Set `TDMM_PRINTER_ENABLED=true`, `docker compose --profile printer up
   -d`; add the printer in **Settings → Printer** (host/serial/access
   code); **Test connection** should report `ok:true` with a real
   `gcode_state`.
3. Export a plate as `.gcode.3mf` from Bambu Studio, upload it to a model,
   open **Files → Print**, pick the plate/AMS/calibration options, and
   **Send** — **the A1 mini starts the print** (the load-bearing
   acceptance for this milestone).
4. On `/printer`: confirm live **%/layer/remaining/temps** update; that
   **Pause/Resume/Stop** work; that **sending while RUNNING is blocked**;
   and that pulling the **microSD card** surfaces an actionable SD-missing
   error.

Record the outcome in the milestone ledger; file any firmware-drift
findings against the pinned-firmware note above.

## Gallery importers

**What it does.** Paste a **Thingiverse** or **Printables** model URL on
`/import`; the app detects the site, downloads every file into a new
library model with full attribution (source link, author, license, tags),
and runs it through the normal ingest pipeline (lands as
`rev-001_imported`). Imports are **atomic** — a failed or paid/Club model
creates no model.

**Thingiverse token setup.** Thingiverse requires a personal **App Token**
to download files: go to `thingiverse.com/apps/create`, register a
**"Desktop app"**, copy the **App Token**, and paste it in **Settings →
Gallery site tokens**. The token is stored masked and never shown again
(blank the field to keep the stored one). Printables needs **no token**
(free models only; **Club/paid models are rejected with a clear
message** — they require a Printables login).

**MakerWorld — not yet.** MakerWorld import is **deferred to a later
milestone** (it needs a Bambu-account login). Pasting a MakerWorld URL
shows a friendly "not available yet" message rather than failing.

**ToS / personal use.** These importers are for **personal use, one model
per action**; by importing you confirm the model's license permits it. The
`/import` page header carries this note. Respect each site's Terms of
Service and the model's license (imported CC attribution is preserved on
the model page).

**Reliability.** The Thingiverse API is historically flaky and the
Printables GraphQL schema is unofficial; both are isolated behind one
module each with recorded-fixture contract tests, and a failed import
never corrupts library state. A `live_importer`-marked smoke test per site
(deferred/manual, excluded from the default gate — see below) hits the
real API on demand.

## Backup & Restore

Three things hold state; back up all three together and they must stay in
sync on restore.

**1. The Postgres database.** Holds models/revisions/files, jobs, settings
(the storage-backend config with its **encrypted** SMB/S3 secret and the
**encrypted** Thingiverse token), and printers (`access_code_enc`). No host
port is published for `db`, so dump through the container:

```sh
docker compose exec db pg_dump -U tdmm tdmm > backup.sql
```

**2. `${TDMM_DATA_DIR}/secrets/printer.key`** (or the matching
`TDMM_PRINTER_KEY` value). **This is the critical one.** As of M6 this single
Fernet key decrypts the printer access codes **and** the SMB/S3 storage
secret **and** the Thingiverse token. **Lose it — or restore a database
against a *different* key — and every encrypted secret becomes permanently
undecryptable** (`InvalidToken`); everything else restores fine, but you'll
be re-entering every credential by hand. The DB dump and this key are a
matched pair: back them up together, restore them together. (Same key
described under [Printer integration → Security](#printer-integration-bambu-lan-feature-flagged).)

**3. The `library/` contents.** For the **local** backend this is the
`./library` bind-mount on the host — copy it like any directory. For the
**SMB** or **S3** backends the library lives on your own share/bucket, which
this app does not manage — back it up with your NAS/S3 tooling. Derivatives
are never stored here (see below).

**Do _not_ bother backing up:**
- `${TDMM_DATA_DIR}/derivatives/**` — thumbnails and GLBs, all **regenerable**
  by re-running the pipeline against the library originals (the migrate task
  documents "derivatives always stay local"). Skipping them keeps backups
  small.
- `${TDMM_DATA_DIR}/spool/**` — transient in-flight upload bytes, meaningless
  after the fact.

**Restore runbook:**

1. Bring up a fresh `db` service and load the dump:
   ```sh
   docker compose up -d db
   docker compose exec -T db psql -U tdmm tdmm < backup.sql
   ```
2. Put `printer.key` back into the `tdmm_data` volume at
   `${TDMM_DATA_DIR}/secrets/printer.key` (mode `0600`), **or** set the same
   `TDMM_PRINTER_KEY` in `.env` — **before** starting api/worker/printerd, so
   the encrypted secrets decrypt and the eager startup re-encryption pass
   (idempotent, safe on already-encrypted data) doesn't run against the wrong
   key.
3. Restore `library/` (local backend) or confirm the SMB share / S3 bucket is
   reachable.
4. `docker compose up -d` — Alembic migrations run automatically on api boot.

The env vars that must match the backed-up stack: `TDMM_DATABASE_URL`,
`TDMM_DATA_DIR`, and the `db` service's `POSTGRES_USER` / `POSTGRES_PASSWORD`
/ `POSTGRES_DB`.

> **Warning:** `docker compose down --volumes` destroys **both** the `pgdata`
> and `tdmm_data` volumes — that is your database, your derivatives, your
> **secrets** (`printer.key`), and the spool, gone together and
> irrecoverably. Like the first-run admin password, none of it comes back
> without a backup. Use plain `docker compose down` (no `--volumes`) to stop
> the stack while keeping state.

**Acceptance (deferred — one-time manual restore drill, not automated):**
like the printer's [live acceptance](#manuallive-acceptance-deferred--user-present-real-a1-mini-not-automated),
a full restore is verified by hand, not in the test suite: `pg_dump` a seeded
stack, `docker compose down --volumes`, then restore the DB + `printer.key` +
`library/` into a fresh stack and confirm the gallery renders, a printer's
access code still decrypts (Test connection succeeds), and a stored SMB/S3
secret still works — proving the key travelled with the DB.

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
uv run pytest        # unit/integration suite (e2e + live_importer excluded via the -m in addopts)
uv run ruff check .
uv run ruff format --check .
```

The full Docker-based end-to-end flow (build image, run compose stack, drive
the M1 upload/revision/diff/download/restart flow, the M2 metadata/GLB/
thumbnail pipeline flow, the M3 scan drill — move a folder on the
bind-mounted share, rescan, relink by hash, download-verify; drop an
untracked folder, rescan, adopt it as a draft model — and the M4 printer
flow — flag off (printers 503, app otherwise fine), flip
`TDMM_PRINTER_ENABLED` on, register a printer, probe it (soft-fails, no
hardware), and confirm a bare `.gcode` and a not-ready printer are both
rejected before any print starts — all over HTTP) lives in
`backend/tests_e2e/` and runs via:

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
