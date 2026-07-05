# 3D Model Manager — Architecture Design & Implementation Plan

**Version:** 1.0 — 2026-07-04
**Status:** Approved stack (FastAPI/Postgres/Redis/React/Docker); this document pins libraries, schema, layouts, and milestones.

One stack adjustment flagged up front: **React 19.2, not 18.** The confirmed 3D viewer path (react-three-fiber 9 + drei 10) hard-requires React 19; the React-18 line of R3F/drei froze in Feb 2025. React 19 satisfies "React 18+" and everything else in the stack (TanStack Query 5, shadcn CLI 4, Tailwind 4) supports it. All other fixed decisions stand unchanged.

---

## 1. Architecture Overview

### Containers (docker-compose, all multi-arch amd64/arm64)

| Service | Image | Role | Ports | Volumes |
|---|---|---|---|---|
| `api` | `3dmm-app` (shared) | FastAPI (uvicorn), serves REST + SSE + built SPA static files | `8080:8080` (only exposed port) | `data:/data`, optional `library:/library` |
| `worker` | `3dmm-app` (same image, different cmd) | Celery worker (`prefork`, concurrency 2), all background jobs | — | `data:/data`, optional `library:/library` |
| `printerd` | `3dmm-app` (same image) | Long-lived Bambu MQTT supervisor: maintains merged printer state, publishes to Redis | — | — |
| `db` | `postgres:16-alpine` | Metadata store | internal 5432 | `pgdata` |
| `redis` | `redis:7-alpine` | Celery broker + result backend, printer-state pub/sub, SSE fan-out | internal 6379 | — |

One application image (`python:3.12-slim` base) with three entrypoints keeps builds simple. The frontend is built in a Node stage and copied into the image; FastAPI serves it with `StaticFiles` + SPA fallback — no nginx/caddy for a single home user (put a reverse proxy in front yourself if you want TLS).

**Why a separate `printerd`:** MQTT to an A1-class printer is a *persistent stateful subscription with incremental diffs* — it does not fit Celery's task model. `printerd` owns the paho-mqtt connection, maintains the merged state dict, throttles `pushall` (≤ 1/5 min), and mirrors state into a Redis key (`printer:{id}:state`, JSON) + pub/sub channel. Celery tasks (upload/start-print) and the API (status endpoint, SSE) read Redis; commands from tasks go through MQTT publish directly (short-lived connection is fine for publishes, or via a Redis command channel that `printerd` executes — we choose the latter so exactly one MQTT session exists, which the printer's weak SoC prefers).

**Data flow (upload example):** browser → `PUT /api/uploads` streamed body → API tees to blake3 hasher + temp file in `/data/spool` → creates `files`/`blobs` rows + enqueues Celery chain (`store_to_backend → extract_metadata → make_derivatives`) → worker streams spool file to the storage backend, then runs extraction/thumbnails against the local spool copy (deleted on success) → SSE notifies the frontend via Redis pub/sub.

**Key volumes:**
- `/data` — app-owned: `spool/` (upload/ingest temp), `derivatives/` (thumbs, GLBs — always local regardless of library backend), `secrets/` (encrypted site tokens).
- `/library` — only mounted when the storage backend is `local`; SMB and S3 backends need no mount (userspace `smbprotocol` needs only outbound TCP 445 — no `SYS_ADMIN`, no CIFS kernel mount).

---

## 2. Data Model (PostgreSQL, SQLAlchemy 2 async + asyncpg, Alembic)

Principle: **`blobs` = content identity (blake3), `files` = a path within a revision snapshot pointing at a blob.** Every revision folder physically contains every file (full snapshot, per the fixed decision); dedup awareness lives purely in the DB via shared blob hashes, and fast-copy (§3) makes the physical duplication cheap where the backend allows.

```
users            (id, username, password_hash[argon2id], created_at)        -- exactly one row in practice
sessions         (id uuid, user_id, created_at, expires_at, last_seen_at)   -- opaque cookie token = id

models           (id, slug UNIQUE, name, description text, source_url, source_site,
                  source_author, source_license, imported_at,
                  current_revision_id FK→revisions, cover_blob_hash FK→blobs,
                  is_archived bool, created_at, updated_at)
tags             (id, name UNIQUE)
model_tags       (model_id, tag_id, PK(model_id, tag_id))
notes            (id, model_id FK, revision_id FK NULL,     -- NULL = model-level note
                  body text[markdown], created_at, updated_at)

revisions        (id, model_id FK, number int, name, note text,
                  dir_name text,            -- e.g. "rev-003_added-drain-holes"
                  created_at,
                  UNIQUE(model_id, number))

blobs            (hash char(64) PK,         -- blake3 hex
                  size bigint, kind enum(mesh,cad,sliced,gcode,image,other),
                  format enum(stl,3mf,obj,step,iges,gcode_3mf,gcode,png,jpg,other),
                  first_seen_at)
files            (id, revision_id FK, blob_hash FK→blobs,
                  rel_path text,            -- path inside the revision dir
                  storage_path text,        -- full backend key, denormalized for rescan
                  mtime timestamptz, verified_at timestamptz,
                  UNIQUE(revision_id, rel_path))

blob_meta        (blob_hash PK FK→blobs,    -- extraction results, per-content so dedup'd
                  triangle_count bigint, dims_mm float[3], volume_cm3 float,
                  surface_area_cm2 float, is_watertight bool,
                  print_time_s int, filament_g float, filament_m float,
                  filament_types text[], layer_height float, nozzle float,
                  printer_model text, plate_count int, raw jsonb)
derivatives      (id, blob_hash FK→blobs, kind enum(thumb_256,thumb_1024,glb,glb_preview),
                  local_path text, status enum(pending,ok,failed,unsupported),
                  error text, tool text, created_at,
                  UNIQUE(blob_hash, kind))
assembly_thumbs  (revision_id PK FK, local_path, status, error)   -- whole-revision render

printers         (id, name, kind enum(bambu_lan), host inet, serial text,
                  access_code_enc bytea, model text default 'A1 mini',
                  enabled bool, options jsonb)   -- options: use_ams, ams_mapping, cali flags
print_jobs       (id, printer_id FK, file_id FK→files, subtask_name,
                  state enum(queued,uploading,starting,printing,paused,finished,failed,canceled),
                  progress_pct int, remaining_min int, layer int, total_layers int,
                  printer_error text, created_at, started_at, ended_at, raw_status jsonb)

imports          (id, url, site enum(printables,makerworld,thingiverse),
                  external_id text, state enum(pending,fetching_meta,downloading,done,failed),
                  model_id FK NULL, error text, meta jsonb, created_at, finished_at)

jobs             (id uuid, celery_id text, type text, subject_type text, subject_id bigint,
                  state enum(queued,running,done,failed,dead), attempts int,
                  error text, created_at, started_at, finished_at)   -- UI-visible job tracking
scan_runs        (id, started_at, finished_at, state,
                  files_seen int, files_hashed int, relinked int, adopted int, missing int,
                  report jsonb)
settings         (key text PK, value jsonb)   -- storage backend config, site tokens (enc), feature flags
```

**How snapshots + dedup read:** "what changed between rev 3 and rev 4" = full outer join of `files` on `rel_path` for the two revisions; equal `blob_hash` ⇒ unchanged, differing ⇒ modified, one-sided ⇒ added/removed. Library-wide dedup stats = `count(*) vs count(distinct blob_hash)` over `files`. Derivatives and metadata attach to blobs, so a file unchanged across 10 revisions gets one thumbnail, one GLB, one metadata extraction — ever.

Indexes that matter: `files(blob_hash)`, `files(storage_path)`, GIN trigram on `models.name` + `models.description` (`pg_trgm`) for search, `tags(name)`, `print_jobs(state)`.

---

## 3. Storage Layer

### Interface — hand-rolled, not fsspec

Per research: fsspec's SMB layer is sync-only with N+1 `stat` listings, s3fs drags the aiobotocore/boto3 pin conflict in, and local reflinks need custom code anyway. We wrap natives behind ~9 methods:

```python
class StorageBackend(Protocol):
    def write(self, key: str, chunks: Iterable[bytes]) -> WriteResult    # returns blake3 + size; atomic (see below)
    def read(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]
    def copy(self, src_key: str, dst_key: str) -> None                   # backend fast path
    def move(self, src_key: str, dst_key: str) -> None
    def delete(self, key: str) -> None
    def exists(self, key: str) -> bool
    def stat(self, key: str) -> StatResult                               # size, mtime (or ETag)
    def walk(self, prefix: str = "") -> Iterator[EntryInfo]              # key, size, mtime — one round-trip per dir
    def mkdirs(self, key_prefix: str) -> None                            # no-op on S3
```

All implementations are **sync**; the API calls them via `anyio.to_thread.run_sync`, Celery calls them directly. One explicit thread boundary beats pretending SMB is async.

| Backend | Libraries (pinned) | write atomicity | `copy` fast path | `walk` |
|---|---|---|---|---|
| `local` | stdlib `pathlib`/`os` | temp file + `os.replace()` same dir | `fcntl.ioctl(dst, FICLONE, src)` (btrfs/XFS reflink, Py≥3.12), fallback `shutil.copyfile` | `os.scandir` recursive |
| `smb` | `smbprotocol>=1.16.1` (high-level `smbclient` API) | UUID temp + `smbclient.replace()` | `smbclient.copyfile()` → SMB2 `FSCTL_SRV_COPYCHUNK` (server-side; reflink-free on Samba+btrfs via `vfs_btrfs`), 1.16.1 auto-falls back client-side | `smbclient.scandir()` using `SMBDirEntry.smb_info` (no per-entry stat) |
| `s3` | `boto3` (pin a pair; **no s3fs/aiobotocore**) | none needed — PUT/CompleteMPU is all-or-nothing; DB commit is the txn boundary; bucket lifecycle rule expires incomplete MPUs | `CopyObject` (≤5 GB, all our files) | `list_objects_v2` paginated |

SMB specifics: sessions registered lazily per worker process (never at import time — Celery prefork fork-safety), `reset_connection_cache()` on worker shutdown, NAS addressed by IP or real DNS (`extra_hosts:` in compose), NTLM over SMB3-with-encryption (smbprotocol default), no Kerberos.

### Streaming + hashing write path

Upload endpoint is a **raw-body `PUT`** (`async for chunk in request.stream()`, ~1 MiB chunks), not multipart — no `SpooledTemporaryFile` double-write. The chunk loop tees: `blake3(max_threads=AUTO).update(chunk)` + append to `/data/spool/{uuid}`. Hash is known the instant the last byte lands (blake3 is far faster than any LAN link). We deliberately **spool locally first**: metadata extraction, thumbnailing, and 3MF unzipping all need local bytes anyway, and it makes backend placement a retryable worker job. Worker then streams spool → `backend.write()` (which re-tees blake3 as a write-integrity check) and commits `files`/`blobs` rows only after the backend write returns.

### Path layout spec

```
<library_root>/
  benchy-calibration/                      ← model dir = models.slug
    rev-001_initial-import/                ← revisions.dir_name = "rev-{number:03d}_{slugified-name}"
      3DBenchy.stl
      3DBenchy.gcode.3mf
      docs/readme.txt                      ← arbitrary subpaths preserved (files.rel_path)
    rev-002_scaled-90pct/
      3DBenchy.stl                         ← full snapshot: present even if byte-identical
      3DBenchy.gcode.3mf
      docs/readme.txt
    .3dmm.json                             ← tiny sidecar: {model_id, slug, name} for portability/adoption hints
```

Derivatives never pollute this tree — they live at `/data/derivatives/{hash[:2]}/{hash[2:4]}/{hash}.{thumb256.png|thumb1024.png|glb|preview.glb}`.

**Creating a revision:** `mkdirs(new dir)` → for each file of the source revision: `backend.copy(old_key, new_key)` (COPYCHUNK / CopyObject / FICLONE — near-instant on capable backends) → insert `files` rows reusing the same `blob_hash` → apply the user's staged adds/replaces/deletes → set `models.current_revision_id`. No re-hashing: copies inherit the source blob hash; `verified_at` stays null until a scan verifies them lazily.

### Rescan / reconcile algorithm (Celery job `scan_library`, manual + optional cron)

1. Snapshot DB state: `{storage_path → (file_id, blob_hash, size, mtime)}`.
2. `backend.walk("")` the whole tree (one listing pass; on SMB this is `scandir`-fast).
3. For each on-disk entry:
   - **Known path, same size+mtime** → touch `verified_at`, skip (no re-hash). *(S3: compare size only; ETags are not content hashes for multipart — never trust them as identity.)*
   - **Known path, changed size/mtime** → re-hash (stream read → blake3). Same hash: update mtime. New hash: this is an out-of-band edit → upsert blob, repoint file row, flag in report, invalidate derivatives if orphaned.
   - **Unknown path** → re-hash. Hash exists in `blobs` → **relink**: this is a moved/copied file; if a DB row's `storage_path` is now missing and matches this hash+`rel_path` shape, repoint it (move); otherwise record as adopted duplicate. Hash unknown → **adopt**: if the path fits `<model>/<rev>/...` under an existing model, attach to that revision; if it's a new top-level folder, create a draft model+rev-001 (flagged "adopted — review me" in UI); enqueue metadata/derivative jobs.
4. DB paths never seen on disk → mark `missing` (report; don't delete rows — user resolves in UI).
5. Write `scan_runs` report; surface in Settings → Storage.

This is the Manyfold lesson applied: folder-shape is only a *hint* used at adoption time; identity is always the hash, so user rearrangement on the NAS reconciles instead of duplicating.

---

## 4. Processing Pipeline (Celery on Redis)

Queues: `io` (backend transfers, imports, printer uploads — concurrency 2), `cpu` (extraction, rendering, conversion — concurrency = cores, `worker_max_memory_per_child` set because OCCT leaks). Every task writes a `jobs` row; retries: 3 with exponential backoff for I/O tasks, **no retry** for deterministic parse failures (mark `failed` with error, or `unsupported`). A task failing never blocks siblings — derivative status is per `(blob, kind)`.

| Job | Trigger | Tools (pinned) | Notes |
|---|---|---|---|
| `store_to_backend` | after upload/import spool | StorageBackend | verifies blake3 on write |
| `extract_metadata` | new blob | **trimesh 4.12+** (`[easy]` extras: lxml, networkx, pillow, scipy) for STL/OBJ/generic-3MF: `faces`, `extents`, `volume`+`is_watertight`, `area`. **lib3mf 2.5** fallback when trimesh's 3MF result is empty/wrong (Bambu Production-Extension files). `numpy-stl` optional STL fast path — skip in v1, trimesh suffices. Sliced `.gcode.3mf`: stdlib `zipfile`+`ElementTree`/`json` only — parse `Metadata/slice_info.config` (prediction=seconds, weight=g, per-filament `used_m`/`used_g`), `project_settings.config` (printer_model, nozzle, filament types/colors), `model_settings.config` (plate list + thumbnail paths), plus `plate_N.gcode` `HEADER_BLOCK` comments. Never mesh-parse sliced files (stub geometry only). Plain `.gcode`: header/footer comment scrape (PrusaSlicer `; filament used [g]`, embedded base64 thumbs). | writes `blob_meta` |
| `extract_embedded_thumbs` | 3MF blobs | `zipfile` — pull `Metadata/plate_N.png` paths from `model_settings.config` (don't hardcode names) | if found, thumbnail job for this blob is skipped |
| `convert_to_glb` | mesh/CAD blobs | STL/OBJ/generic-3MF: trimesh → `Scene.export(file_type="glb")`. Bambu project 3MF: **lib3mf** → verts/tris → trimesh → GLB (assimp/trimesh can't follow Production-Extension refs). **STEP: cascadio 0.0.17** (`trimesh.load("part.step")` just works, 25 MB wheel). **IGES: v1 = `unsupported`** ("stored + downloadable, no preview"); Phase-2 option: `cadquery-ocp 7.9.x` `IGESControl_Reader` → `BRepMesh_IncrementalMesh` (+~400 MB image — feature-flagged build arg). | keeps mm/Z-up; viewer normalizes camera; true dims come from `blob_meta`, never the GLB |
| `optimize_glb` | after convert | `gltfpack` (meshoptimizer 1.2, static binary in image): `-cc` → `glb` derivative; additionally `-si 0.5` preview LOD when >1.5 M triangles → `glb_preview` | ~10–20× smaller than STL; meshopt over Draco (tiny fast decoder) |
| `render_thumb` | blobs without embedded thumb | **f3d 3.5 wheel** + `apt: libosmesa6 libgl1-mesa-dri`; `Engine.create_osmesa()`, SSAA + AO, 256² + 1024²; input = the GLB derivative (one render path for every format, incl. STEP via cascadio) | Manyfold's F3D pivot validates server-side thumbs |
| `render_assembly_thumb` | revision complete / files changed | trimesh: concatenate all mesh GLBs of the revision into one scene → f3d | the "assembly" thumbnail per fixed decision |
| `scan_library` | manual / cron | §3 algorithm | singleton lock in Redis |
| `import_from_url` | user pastes URL | §6 | streams straight to spool → normal ingest chain |
| `printer_send` | user clicks Print | §5 | queue `io` |

Chain per new blob: `extract_metadata → [extract_embedded_thumbs] → convert_to_glb → optimize_glb → render_thumb`; failures downstream leave earlier results intact.

---

## 5. Printer Integration (Bambu A1 mini, LAN Developer Mode)

**Approach:** `bambulabs-api` (PyPI, MIT, v2.6.x, active) wrapped behind our own `PrinterAdapter` ABC — it's thin enough that a raw `paho-mqtt` + 30-line `ImplicitFTP_TLS` rewrite is a contained ~200-line fallback if it ever stalls. **Do not** touch the Bambu Connect signed path. TLS: printer certs are self-signed (BBL private CA) — v1 disables verification like every working client; TOFU-pin the captured cert as a nice-to-have.

**Prerequisite (documented in setup wizard):** printer firmware ≥ 01.05.00.00, LAN-only Mode ON → power-cycle → **Developer Mode ON**. Wizard verifies by connecting to `:8883` as `bblp`/access-code and issuing `pushall`; explains the tradeoff (Bambu Cloud/Handy disconnects, firmware updates via microSD).

**Config** (`printers` row): host (static IP/DHCP reservation — no mDNS), serial, access code (encrypted at rest with app secret via `cryptography.fernet`), options jsonb (`use_ams` default **false**, `ams_mapping` default `[0]`, `bed_levelling`/`flow_cali`/`vibration_cali`/`timelapse` checkboxes). Multi-printer-shaped from day one (list + FK), one row in practice.

**Send-to-printer flow** (`printer_send` task):
1. Validate file is `.gcode.3mf`: ZIP containing `Metadata/plate_*.gcode` — hard-reject plain `.gcode` for remote start (unreliable on modern firmware).
2. Preflight: read merged state from Redis; require `gcode_state ∈ {IDLE, FINISH, FAILED}` (printer silently ignores `project_file` while RUNNING). Surface SD-card errors ("SD card missing/full") as first-class failures.
3. FTPS upload: implicit TLS port 990, `bblp`/access-code, `storbinary` 32 KB blocks, **`conn.unwrap()` after transfer** (hang workaround), one file at a time, destination `/cache/{subtask_name}.gcode.3mf`.
4. MQTT `print.project_file` to `device/{serial}/request`: `param="Metadata/plate_N.gcode"` (plate picked in UI when multi-plate, from `model_settings.config`), `url="file:///sdcard/cache/{name}.gcode.3mf"` (must match upload path exactly), `subtask_name`, cali/timelapse flags from options. Fields exactly right — malformed commands are silently ignored.
5. Create `print_jobs` row; `printerd` transitions it from report stream.

**Status surfacing (`printerd`):** persistent paho-mqtt session, subscribes `device/{serial}/report`, **merges incremental diffs** into a state dict (A1-class never sends full state unprompted), `pushall` only on connect and ≥5-min rebaseline. Tracked fields: `gcode_state`, `mc_percent`, `mc_remaining_time`, `layer_num`/`total_layer_num`, `print_error`, `nozzle_temper`/`bed_temper`, `subtask_name`, `gcode_file`, `wifi_signal`, `ams_status`. Mirrors to Redis `printer:{id}:state` + publishes deltas; API exposes `GET /printers/{id}/status` and an SSE stream; pause/resume/stop commands go via Redis command channel → `printerd` publishes MQTT. Entire integration behind a `printer.enabled` feature flag (firmware-drift insurance). Camera (port 6000 JPEG stream) is explicitly out of v1 scope; the protocol is documented if we want a snapshot endpoint later.

---

## 6. Gallery Importers

Common interface (Manyfold's deserializer pattern as a Python Protocol), executed in `import_from_url`:

```python
class SiteImporter(Protocol):
    site: str
    def canonicalize(self, url: str) -> str | None        # → external_id, or None if not ours
    def fetch_metadata(self, ext_id: str) -> ImportMeta   # title, description(html→md), author, license, tags, images
    def list_files(self, ext_id: str) -> list[RemoteFile] # name, size, category(stl/gcode/other)
    def resolve_download(self, f: RemoteFile) -> str      # short-lived URL — stream IMMEDIATELY
```

| Site | Strategy | Auth | Fragility |
|---|---|---|---|
| **Thingiverse** | Official REST `api.thingiverse.com`: `GET /things/{id}` (use `zip_data.files[]`/`images[]` URLs, Manyfold-style) | User-supplied App Token (Settings page; "Desktop app" registration), `Authorization: Bearer` | Low — sanctioned path; API flaky historically → retries + clear errors. 300 req/5 min irrelevant. Map license strings manually (Manyfold distrusts the field). |
| **Printables** | Unofficial GraphQL `POST api.printables.com/graphql/` (works anonymously today, browser-like UA): `print(id:)` query for metadata; `getDownloadLink` mutation → CDN URL (24 h TTL). ID = numeric slug prefix. | None (free models). Skip Club/paid (needs JWT) with a clear error. | Medium — undocumented schema; isolate queries in one module, integration-test against model 3161. Cloudflare may tighten → `cloudscraper` fallback hook. |
| **MakerWorld** | **Feature-flagged.** Metadata anonymous via `GET api.bambulab.com/v1/design-service/design/{id}` (title, license, tags, creator, `instances[]` print profiles, `hasZipStl`, paid/exclusive flags → reject those). Downloads: `GET /v1/iot-service/api/user/profile/{profileId}?model_id=` with Bambu Cloud Bearer token → presigned S3 URL valid ~5 min — fetch instantly, never normalize/cache the URL. | "Connect Bambu account" flow: `POST /v1/user-service/user/login`, handle `loginType:"verifyCode"` (email-code MFA UI). Token ~90 days, encrypted in `settings`; refresh endpoint is broken → re-login UX with expiry banner. | High — strictest ToS, WAF makes any HTML fallback impossible. Escape hatch if it breaks: mmp-companion-style browser extension "push to library" (post-v1). |

All importers stream downloads straight to spool → standard ingest chain (hash, snapshot into `rev-001_imported`, metadata, thumbs). **Provenance is always stored** (`source_url`, `source_site`, `source_author`, `source_license`, `imported_at`) — CC attribution requires it. Site cover images are downloaded as gallery fallbacks until our own renders complete. ToS note shown once in UI for Printables/MakerWorld (personal-use importer, one model per user action).

---

## 7. API Surface (all under `/api`, session-cookie auth except `/auth/login`)

| Method + Path | Purpose |
|---|---|
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | argon2id check → HttpOnly SameSite=Lax cookie |
| `GET /models` | gallery: `q` (trigram), `tags`, `format`, `has_sliced`, `sort`, cursor pagination |
| `POST /models`, `GET/PATCH/DELETE /models/{id}` | create (name→slug), read (with current rev + tags), edit, archive/delete |
| `GET /models/{id}/revisions`, `POST .../revisions` | list; create snapshot (name, note, staged file ops) |
| `GET /revisions/{id}`, `GET /revisions/{a}/diff/{b}` | file list w/ blob meta; hash-diff (added/removed/changed) |
| `PUT /uploads?filename=&model=&revision=` | raw-body streaming upload → spool + hash; returns file+job ids |
| `GET /files/{id}/download` | `StreamingResponse` from backend (sync gen → threadpool), Content-Disposition original name |
| `GET /blobs/{hash}/thumb?size=256|1024`, `GET /blobs/{hash}/glb?lod=full|preview` | derivative serving (local disk, `FileResponse`, immutable cache headers — hash-addressed) |
| `GET /revisions/{id}/thumb` | assembly thumbnail |
| `POST /notes`, `PATCH/DELETE /notes/{id}` | model- and revision-level notes |
| `GET /tags`, `POST /models/{id}/tags`, `DELETE .../tags/{tag}` | tagging |
| `POST /imports` (body: url), `GET /imports/{id}` | import-by-URL; poll state |
| `GET /printers`, `POST /printers`, `PATCH /printers/{id}`, `POST /printers/{id}/test` | config + Developer-Mode verification (pushall probe) |
| `GET /printers/{id}/status` | merged state from Redis |
| `POST /printers/{id}/print` (file_id, plate, options), `POST .../pause|resume|stop` | print control |
| `GET /print-jobs`, `GET /print-jobs/{id}` | history |
| `POST /scan`, `GET /scan-runs`, `GET /scan-runs/{id}` | rescan/reconcile + reports |
| `GET /jobs?state=&subject=` | background job visibility, retry button (`POST /jobs/{id}/retry`) |
| `GET/PUT /settings/{key}` | storage backend config, site tokens, feature flags |
| `GET /events` | **SSE**: job updates, printer state deltas, scan progress (Redis pub/sub fan-out) |

---

## 8. Frontend

**Stack (pinned):** React 19.2 · Vite 8 (Rolldown) · TypeScript 5.x strict · Tailwind 4 (CSS-first, `@tailwindcss/vite` plugin, no config file) · shadcn CLI 4 with **`-b radix`** (Radix flavor per spec — pin the flag in scaffold scripts since Base UI is now the default) · TanStack Query 5 + TanStack Router · `@react-three/fiber` 9.6 + `@react-three/drei` 10.7 + three r185.

**Routes:**

| Route | Page |
|---|---|
| `/login` | single admin login |
| `/` | **Gallery**: responsive card grid (assembly/cover thumb, name, tag chips, format badges, print-time badge if sliced), debounced search, tag/format/has-sliced filter sidebar, sort, infinite scroll (`useInfiniteQuery`) |
| `/models/:slug` | **Model detail**: header (name, tags, provenance/license, cover), tabbed: *Files* (per-file thumb, dims/tris/weight from `blob_meta`, download, "Print" on `.gcode.3mf`), *3D view*, *Revisions* (timeline; diff view = added/removed/changed rows via hash diff; "New revision" flow: name + note + stage add/replace/delete), *Notes* (markdown, model- and per-revision) |
| `/upload` | drag-drop multi-file → per-file streamed PUT with progress; target = new model or existing model/new revision; live job status via SSE |
| `/import` | paste URL → site auto-detected → metadata preview card (title/author/license/images) → file checklist → import; MakerWorld shows "connect Bambu account" gate |
| `/printer` | status panel (state, %, layers, remaining, temps — SSE live), print-job history, pause/resume/stop; send-print dialog (plate picker, AMS advanced toggle, cali checkboxes) |
| `/settings` | storage backend (local path / SMB host+share+creds / S3 endpoint+bucket+keys) + "test connection", scan trigger + last scan report (adopted/relinked/missing lists with resolve actions), site tokens (Thingiverse token, Bambu login), printer setup wizard, feature flags |
| `/jobs` | background job table with retry |

**Viewer strategy** (one `<ModelViewer3D url />`, ~50 lines): `<Canvas frameloop="demand">` + drei `<Stage>` + `<OrbitControls makeDefault>` (rotate/zoom only per spec) + `<Bounds fit clip>` + `useGLTF` with `MeshoptDecoder` registered. **GLB is the only format the viewer loads** — the server pipeline guarantees it:

| Source format | Viewer input |
|---|---|
| STL / OBJ / generic 3MF | `glb` derivative (`glb_preview` LOD auto-selected > 1.5 M tris); while conversion pending: placeholder + job status (native `STLLoader` fallback only for files < 10 MB, in a Web Worker — optional M3 polish) |
| Bambu project 3MF | server lib3mf→GLB only — never `ThreeMFLoader` (no Production Extension support) |
| Sliced `.gcode.3mf` | no mesh render: embedded `plate_N.png` carousel + slice-info panel (time, filament, printer, plates) |
| STEP | cascadio-produced GLB |
| IGES / plain `.gcode` | "no preview" card + metadata + download |

---

## 9. Phased Implementation Plan

**M1 — Core library on local storage (usable: upload, browse, download)**
Scope: compose skeleton (api/worker/db/redis, single image, multi-arch buildx CI), Alembic baseline for full schema §2, auth (argon2id + session cookie, first-run admin creation), `StorageBackend` protocol + **local** impl (incl. FICLONE copy), streaming PUT upload with blake3 tee + spool, model/revision/file/tag/note CRUD, path-layout writer, `store_to_backend` + `jobs` tracking, frontend scaffold (Vite 8/React 19/Tailwind 4/shadcn `-b radix`), Gallery (no thumbs yet — format placeholders), Model detail (files/revisions/notes), Upload page, SSE job updates.
Key modules: `app/storage/{base,local}.py`, `app/api/{auth,models,revisions,uploads,files}.py`, `app/tasks/ingest.py`, `web/src/routes/{index,models.$slug,upload}.tsx`.
Accept: upload a 200 MB STL through the browser with progress; create rev-002 that snapshots rev-001 near-instantly on btrfs; hash-diff shows changed files; tree on disk matches §3 spec exactly; restart-safe.

**M2 — Processing pipeline: metadata, thumbnails, GLB, viewer**
Scope: `extract_metadata` (trimesh/lib3mf/zipfile branches incl. full sliced-3MF parsing), `extract_embedded_thumbs`, `convert_to_glb` (trimesh + lib3mf + cascadio for STEP), `optimize_glb` (gltfpack in image), `render_thumb` + `render_assembly_thumb` (f3d OSMesa; image gains libosmesa6), derivative serving endpoints with immutable caching, R3F viewer component, gallery thumbs + metadata badges, sliced-file plate panel.
Accept: STL/OBJ/3MF/STEP each show correct thumb + dims/tris/volume; a Bambu-Studio-default project 3MF (Production Ext) renders correctly; a sliced `.gcode.3mf` shows plate PNGs + print time/filament; 2 M-triangle STL orbits smoothly via preview LOD; IGES gracefully "no preview".

**M3 — Pluggable storage + scanner**
Scope: **SMB** backend (smbprotocol: lazy sessions, scandir walk, COPYCHUNK copy, replace() atomic writes) and **S3** backend (boto3, CopyObject, MPU lifecycle doc), settings UI with connection test + one-time migration helper (local→X), `scan_library` job (§3 algorithm) + scan report UI with adopt/relink/missing resolution, optional scheduled scan.
Accept: point library at a Samba share from the container with no privileged flags; snapshot copy on Samba is server-side (verify traffic); drop a folder of STLs onto the NAS out-of-band → scan adopts it as a draft model with thumbs; move a model folder on the NAS → scan relinks by hash with zero re-downloads of unchanged content (size+mtime skip).

**M4 — Printer integration (feature-flagged)**
Scope: `printerd` service (paho-mqtt merged-diff state, pushall throttle, Redis mirror + command channel), `PrinterAdapter` over bambulabs-api (ImplicitFTP_TLS upload w/ unwrap, project_file command), setup wizard w/ Developer-Mode probe + docs, send-print flow (validation, preflight, plate/AMS/cali options), status panel + SSE, print-job history, pause/resume/stop.
Accept: from Model detail, send a `.gcode.3mf` to the A1 mini and watch it start; live %, layer, remaining update; sending while RUNNING is blocked client- and server-side; SD-card-missing produces an actionable error; app fully functional with flag off.

**M5 — Gallery importers**
Scope: `SiteImporter` protocol + Thingiverse (official API, token in settings) + Printables (GraphQL, anonymous) importers; import UI (URL → preview → file selection → progress); provenance fields on model page; MakerWorld behind flag: Bambu login (verify-code UX, encrypted 90-day token, expiry banner), design-service metadata, 5-min presigned download handling.
Accept: paste a Printables URL → model with files, license, author, tags, cover in library within a minute; Thingiverse thing imports via `zip_data`; MakerWorld free model imports with connected account; paid/Club/exclusive models rejected with clear message; every import shows attribution.

**M6 — Hardening & polish**
Scope: TOFU cert pinning for printer TLS; retries/dead-letter UX pass; backup/restore doc (pg_dump + derivatives are regenerable + library is plain files); optional IGES via cadquery-ocp build flag; optional `bambustudio://` open-in-slicer deep link (printarr lesson); small-file native STL preview in Web Worker; perf pass (gallery ≥ 1 k models, scan ≥ 50 k files); README with Developer-Mode + ToS notes.
Accept: kill worker mid-ingest → clean recovery; full restore drill from backup; 1 k-model gallery interactive < 1 s.

---

## 10. Risks & Mitigations

| Risk | Likelihood/Impact | Mitigation |
|---|---|---|
| **Bambu firmware removes/breaks Developer Mode** or changes MQTT/FTPS behavior | Med / High (whole printer feature) | Feature flag + adapter interface; pin known-good firmware (01.08.00.00) in docs; setup wizard probes and reports exact failure; app is fully useful without the printer; worst-case fallback documented: export to SD / Bambu Studio. Never build on the signed Bambu Connect path. |
| **MakerWorld API breaks / account suspension risk (strictest ToS)** | High / Med | Shipped last, behind flag, with explicit ToS notice; anonymous metadata separated from token-gated downloads; browser-extension "push to library" (mmp-companion pattern) as designed escape hatch; Printables + Thingiverse cover most needs. |
| **Printables GraphQL schema drift / Cloudflare tightening** | Med / Med | All queries in one module with contract tests against a known model ID; graceful "importer degraded" error, cloudscraper fallback hook; failure never corrupts library state (imports are atomic: model created only on success). |
| **STEP/IGES tooling in Docker** (OCCT size/instability) | Med / Med | STEP via cascadio only (+25 MB wheel, pure pip, no conda); IGES deliberately deferred behind a build flag (+~400 MB cadquery-ocp) with "no preview" as the honest default; conversion isolated in `cpu` queue with memory-capped, recycled workers so an OCCT crash kills a task, not the app. |
| **Bambu Production-Extension 3MFs mis-parse** (Manyfold's #1 complaint) | Med / Med | lib3mf (reference implementation, supports the extension) is the mandated path for Bambu 3MFs; trimesh result validated (non-empty, sane bounds) before acceptance; test corpus of real Bambu Studio/Orca exports in CI. |
| **SMB quirks** (fork-unsafe session cache, slow listings, name resolution in containers) | Med / Med | Lazy per-process sessions + cache reset on shutdown; `scandir` with `smb_info` (no N+1 stats) for scans; IP/DNS-only addressing documented (`extra_hosts:`); COPYCHUNK fallback handled by smbprotocol ≥ 1.16.1; atomic writes via `smbclient.replace()`. |
| **s3fs/aiobotocore pin hell** | — (avoided) | We don't ship fsspec/s3fs at all — boto3 only. |
| **Full-snapshot revisions bloat storage on dumb backends** (S3, ext4) | Low / Med | By design (user decision); DB dedup stats make the cost visible; S3 uses CopyObject (no egress, but real storage); docs recommend btrfs/XFS locally and Samba-on-btrfs for reflink snapshots; hashes make a future GC/hard-link optimization possible without migration. |
| **React 19 requirement vs. "React 18+" decision** | Low / Low | Flagged in §0; 19 satisfies "18+"; if 18 were reimposed, pin fiber 8.18/drei 9.122 (dead branch — not recommended). |
| **Large-mesh browser performance** | Low / Med | meshopt-compressed GLB + decimated preview LOD server-side; `frameloop="demand"`; thumbnails never depend on the browser renderer (Manyfold's F3D lesson). |
| **A1 SoC fragility** (pushall hammering, silent command drops, FTPS hangs) | Med / Low | Single MQTT session owned by `printerd`; ≥5-min pushall floor; exact-field project_file payload with integration test fixture; `unwrap()` FTPS workaround; sequential uploads only. |