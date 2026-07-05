# 3D Model Manager — Design & Implementation Plan

## Context

Greenfield project at `/home/OLYMPOS/jagannath/projects/3d-model-manager` (empty dir, not yet a git repo). A self-hosted web app to manage a personal library of 3D-printable models: pluggable storage (SMB/S3/local), gallery with thumbnails, in-browser 3D viewer (view/spin only), model-level revisions with notes, metadata extraction, import-by-URL from online galleries, and send-to-printer for a Bambu Lab A1 mini over LAN. No slicing in-app — user slices in Bambu Studio and uploads the sliced `.gcode.3mf`.

All product decisions below were confirmed with the user; technical choices are grounded in a 5-agent research pass (Bambu LAN protocol post-2025 firmware, gallery APIs, Python 3D tooling, storage libraries, prior art — full findings in session scratchpad `research-*.md`, to be committed to the repo as reference docs).

## Requirements (confirmed)

1. Web app; fast/efficient. Single admin login (username/password session).
2. Formats: STL, 3MF, OBJ, STEP, IGES + sliced `.gcode.3mf`/`.gcode` artifacts. **All viewable formats get previews in v1, including IGES.**
3. Pluggable storage: **in-app SMB client**, **S3**, local dir — behind an **extensible backend interface** (adding e.g. WebDAV/NFS/SFTP later = implement the protocol + register, no core changes). Human-readable tree; app manages layout.
4. **Model-level revisions, full snapshot per revision folder** (all files copied even if unchanged). Every file content-hashed (blake3); DB knows which files actually changed (badges in UI); rescan re-links moved files by hash.
5. Thumbnails stored per component file AND per assembly (extracted from 3MF when embedded, else server-rendered).
6. Browser 3D viewer — rotate/zoom/pan (no editing).
7. Upload/download via browser; notes on models and revisions; tags; gallery with search/filters.
8. Import-by-URL: **Printables, MakerWorld, Thingiverse** (with provenance/license capture).
9. Send sliced files to **Bambu A1 mini via LAN** (FTPS upload + MQTT print start/status). Multi-printer-shaped, one printer in practice — behind an **extensible `PrinterAdapter` interface** (`printers.kind` discriminates adapters; future Moonraker/Klipper, OctoPrint, PrusaLink adapters slot in without core changes; only `bambu_lan` implemented in v1).
10. Scanner job: walk storage, hash, reconcile moves, adopt out-of-band files. Library starts empty.

## Key research findings that shaped the design

- **Bambu LAN (post-Jan-2025):** firmware ≥ 01.05 requires **LAN-only Mode + Developer Mode** enabled on the printer for direct MQTT (:8883) / FTPS (:990) access. `bambulabs-api` (PyPI, MIT, active) is the recommended lib, wrapped behind our own adapter; never build on the signed Bambu Connect path. A1-class printers send incremental MQTT diffs (need merged-state daemon; throttle `pushall`).
- **Bambu 3MF gotcha:** Bambu Studio writes 3MF with the Production Extension — three.js `ThreeMFLoader` and often trimesh fail on these (Manyfold's #1 complaint for years). **lib3mf** handles them; sliced `.gcode.3mf` should never be mesh-parsed — extract embedded `Metadata/plate_N.png` + `slice_info.config` instead.
- **Viewer:** normalize everything server-side to **meshopt-compressed GLB** (gltfpack); react-three-fiber 9 + drei 10 **require React 19** (React-18 line of R3F/drei is frozen/dead) → **React 19.2, not 18**.
- **STEP:** `cascadio` (25 MB pip wheel, trimesh integration) — no conda/OCCT pain. **IGES: v1 preview included** via `cadquery-ocp` (pip wheel: `IGESControl_Reader` → `BRepMesh_IncrementalMesh` → trimesh → GLB). Adds ~400 MB to the shared app image, but the image is shared by api/worker/printerd so the disk cost is paid once; OCCT instability is contained by the memory-recycled `cpu` Celery queue.
- **Thumbnails:** **f3d** python wheel with OSMesa software rendering in-container (Manyfold independently switched to F3D server-side rendering in 2026 — validates approach).
- **Storage:** skip fsspec/s3fs (sync-only SMB layer, N+1 stats, aiobotocore pin hell). Hand-rolled ~9-method `StorageBackend` protocol over `smbprotocol` (smbclient API), `boto3`, and stdlib — each with a native fast-copy path (SMB2 COPYCHUNK / S3 CopyObject / Linux FICLONE reflink) making full-snapshot revisions near-instant on capable backends.
- **Galleries:** Thingiverse = official REST API (user-supplied app token). Printables = unofficial GraphQL (works anonymously; isolate + contract-test). MakerWorld = feature-flagged, anonymous metadata + Bambu-account-token downloads (5-min presigned URLs, ~90-day token, strictest ToS).
- **Prior art (Manyfold) lessons:** don't guess "folder = model" at scan time (hash is identity, folder shape only an adoption hint); render thumbnails server-side; handle Bambu 3MFs day one.

## Architecture

Containers (docker-compose, multi-arch amd64/arm64, one shared app image `python:3.12-slim` with three entrypoints; frontend built in Node stage, served by FastAPI StaticFiles + SPA fallback):

| Service | Role | Ports/Volumes |
|---|---|---|
| `api` | FastAPI (uvicorn): REST + SSE + SPA | `8080:8080`; `data:/data`, optional `library:/library` |
| `worker` | Celery (prefork): all background jobs, queues `io` (conc 2) + `cpu` (conc=cores, memory-recycled — OCCT leaks) | same volumes |
| `printerd` | Long-lived Bambu MQTT supervisor: single paho-mqtt session, merges incremental diffs → Redis `printer:{id}:state` + pub/sub; executes commands from a Redis command channel | — |
| `db` | postgres:16-alpine | internal |
| `redis` | redis:7-alpine — Celery broker/results, printer state, SSE fan-out | internal |

`/data` = app-owned: `spool/` (upload temp), `derivatives/` (thumbs/GLBs — always local), `secrets/`. `/library` mounted only for the `local` backend; SMB needs just outbound TCP 445 (no privileged container), S3 needs nothing.

**Upload flow:** browser → raw-body streamed `PUT` → API tees chunks to blake3 + `/data/spool/{uuid}` → DB rows + Celery chain `store_to_backend → extract_metadata → [extract_embedded_thumbs] → convert_to_glb → optimize_glb → render_thumb` → SSE progress via Redis pub/sub.

## Data model (PostgreSQL, SQLAlchemy 2 async + asyncpg, Alembic)

Principle: **`blobs` = content identity (blake3 hash PK); `files` = a path within a revision snapshot pointing at a blob.** Full physical snapshot per revision; dedup awareness purely in DB. Metadata + derivatives attach to blobs → a file unchanged across 10 revisions gets one thumbnail/GLB/extraction ever.

```
users(id, username, password_hash[argon2id], created_at)
sessions(id uuid=cookie token, user_id, created_at, expires_at, last_seen_at)
models(id, slug UNIQUE, name, description, source_url, source_site, source_author,
       source_license, imported_at, current_revision_id FK, cover_blob_hash FK,
       is_archived, created_at, updated_at)
tags(id, name UNIQUE); model_tags(model_id, tag_id)
notes(id, model_id FK, revision_id FK NULL /*NULL=model-level*/, body md, timestamps)
revisions(id, model_id FK, number, name, note, dir_name /*"rev-003_added-drain-holes"*/,
          created_at, UNIQUE(model_id, number))
blobs(hash char(64) PK, size, kind enum(mesh,cad,sliced,gcode,image,other),
      format enum(stl,3mf,obj,step,iges,gcode_3mf,gcode,png,jpg,other), first_seen_at)
files(id, revision_id FK, blob_hash FK, rel_path, storage_path /*denorm for rescan*/,
      mtime, verified_at, UNIQUE(revision_id, rel_path))
blob_meta(blob_hash PK, triangle_count, dims_mm[3], volume_cm3, surface_area_cm2,
          is_watertight, print_time_s, filament_g, filament_m, filament_types[],
          layer_height, nozzle, printer_model, plate_count, raw jsonb)
derivatives(id, blob_hash FK, kind enum(thumb_256,thumb_1024,glb,glb_preview),
            local_path, status enum(pending,ok,failed,unsupported), error, tool,
            created_at, UNIQUE(blob_hash, kind))
assembly_thumbs(revision_id PK, local_path, status, error)
printers(id, name, kind enum(bambu_lan), host, serial, access_code_enc /*fernet*/,
         model, enabled, options jsonb /*use_ams, ams_mapping, cali flags*/)
print_jobs(id, printer_id FK, file_id FK, subtask_name, state enum(queued,uploading,
           starting,printing,paused,finished,failed,canceled), progress_pct,
           remaining_min, layer, total_layers, printer_error, timestamps, raw_status jsonb)
imports(id, url, site enum, external_id, state enum, model_id FK NULL, error, meta jsonb, timestamps)
jobs(id uuid, celery_id, type, subject_type, subject_id, state, attempts, error, timestamps)
scan_runs(id, timestamps, state, files_seen, files_hashed, relinked, adopted, missing, report jsonb)
settings(key PK, value jsonb)
```

Revision diff = full outer join of `files` on `rel_path` between two revisions (same hash ⇒ unchanged). Indexes: `files(blob_hash)`, `files(storage_path)`, pg_trgm GIN on `models.name/description`, `print_jobs(state)`.

## Storage layer

Hand-rolled sync `StorageBackend` Protocol (API calls it via `anyio.to_thread.run_sync`; Celery direct). **Explicitly extensible**: backends self-register in a registry keyed by scheme (`local` / `smb` / `s3`), config validated per-backend via pydantic models in `settings`; adding WebDAV/NFS/SFTP later means one new module implementing the ~9 methods + a registry entry — no changes to ingest, revisions, or the scanner, which only speak the protocol.

```python
write(key, chunks) -> WriteResult(blake3, size)   # atomic per-backend
read(key, start=0, end=None) -> Iterator[bytes]
copy(src, dst)   # fast path: FICLONE / SMB COPYCHUNK / S3 CopyObject
move, delete, exists, stat, walk(prefix), mkdirs
```

| Backend | Libs | Atomic write | Fast copy |
|---|---|---|---|
| local | pathlib/os | temp + `os.replace()` | `fcntl.FICLONE` reflink, fallback copyfile |
| smb | `smbprotocol>=1.16.1` smbclient API | UUID temp + `smbclient.replace()` | `copyfile()` → SMB2 COPYCHUNK (auto client-side fallback) |
| s3 | boto3 (no s3fs/fsspec) | PUT/MPU all-or-nothing; lifecycle rule expires incomplete MPUs | CopyObject |

SMB: lazy per-process sessions (Celery prefork fork-safety), `scandir` with `smb_info` (no N+1 stats), IP/DNS addressing (`extra_hosts:`), NTLM over SMB3-encryption.

**Path layout:**
```
<library_root>/<model-slug>/rev-001_initial-import/  ← full file set incl. subpaths
                            rev-002_scaled-90pct/    ← full snapshot even if unchanged
                            .3dmm.json               ← sidecar {model_id, slug, name}
```
Derivatives live at `/data/derivatives/{hash[:2]}/{hash[2:4]}/{hash}.*` — never in the library tree.

**New revision:** mkdirs → `backend.copy()` each source file (near-instant on btrfs/Samba-btrfs/S3) → insert `files` rows reusing blob hashes → apply staged add/replace/delete → bump `current_revision_id`. No re-hashing.

**Rescan/reconcile (`scan_library`):** snapshot DB `{storage_path → (file, hash, size, mtime)}` → `walk()` tree → known path + same size/mtime ⇒ touch `verified_at` (S3: size only, ETags lie); changed ⇒ re-hash (out-of-band edit → repoint); unknown path ⇒ re-hash → hash known ⇒ **relink** (move) or duplicate; hash unknown ⇒ **adopt** (attach to matching model/rev by path shape, or create draft model flagged "review me") → missing DB paths marked `missing` (never auto-delete) → `scan_runs` report in UI.

## Processing pipeline (Celery jobs)

| Job | Tooling |
|---|---|
| `extract_metadata` | trimesh 4.12+ `[easy]` (STL/OBJ/generic-3MF: faces, extents, volume, watertight, area); **lib3mf 2.5** fallback for Bambu Production-Ext 3MF; sliced `.gcode.3mf`: stdlib zipfile+ET/json parse of `slice_info.config` (time s, weight g, per-filament), `project_settings.config` (printer, nozzle, filaments), `model_settings.config` (plates); plain `.gcode`: header comment scrape |
| `extract_embedded_thumbs` | zipfile → `Metadata/plate_N.png` (paths from model_settings, not hardcoded) |
| `convert_to_glb` | trimesh → GLB; Bambu 3MF via lib3mf→trimesh; **STEP via cascadio**; **IGES via cadquery-ocp** (IGESControl_Reader → BRepMesh_IncrementalMesh → trimesh → GLB) |
| `optimize_glb` | `gltfpack -cc` (meshopt) → `glb`; `-si 0.5` preview LOD when >1.5M tris → `glb_preview` |
| `render_thumb` | **f3d 3.5** wheel + libosmesa6, OSMesa offscreen, input = GLB derivative, 256² + 1024² |
| `render_assembly_thumb` | concatenate revision's mesh GLBs → one scene → f3d |
| `scan_library`, `import_from_url`, `printer_send`, `store_to_backend` | per sections above |

Failures: per-(blob,kind) status; deterministic parse failures don't retry; I/O retries 3× exp backoff; every task tracked in `jobs` (UI-visible, retry button).

## Printer integration (feature-flagged `printer.enabled`)

- **Extensible adapter architecture:** `PrinterAdapter` ABC (capabilities: upload_and_start, pause/resume/stop, status-stream) with a registry keyed by `printers.kind`; `printerd` and the API only speak the ABC, so future Moonraker/Klipper, OctoPrint, or PrusaLink adapters are new modules + enum values, no core changes. v1 ships `bambu_lan` only.
- Lib: `bambulabs-api` behind the adapter (raw paho-mqtt+ImplicitFTP_TLS is a contained ~200-line fallback). TLS verify off in v1 (BBL self-signed CA); TOFU pin later.
- Setup wizard: documents firmware ≥ 01.05 + LAN-only Mode + Developer Mode; verifies by MQTT connect + `pushall` probe; explains tradeoffs.
- Send flow: validate `.gcode.3mf` (contains `Metadata/plate_*.gcode`; hard-reject bare `.gcode` for remote start) → preflight state ∈ {IDLE, FINISH, FAILED} from Redis → FTPS implicit TLS :990 upload to `/cache/` (32KB blocks, `conn.unwrap()` hang workaround, sequential only) → MQTT `print.project_file` to `device/{serial}/request` with `param="Metadata/plate_N.gcode"` (UI plate picker for multi-plate), `url="file:///sdcard/cache/…"` exactly matching upload path, AMS/cali options → `print_jobs` row transitions from report stream.
- `printerd` tracks: gcode_state, mc_percent, mc_remaining_time, layer/total, print_error, temps, subtask_name, wifi, AMS. API: `GET /printers/{id}/status` + SSE; pause/resume/stop via Redis command channel. Camera out of v1 scope.

## Gallery importers

Common `SiteImporter` protocol: `canonicalize(url)`, `fetch_metadata`, `list_files`, `resolve_download` (short-TTL URLs streamed immediately to spool → normal ingest chain, landing as `rev-001_imported`). Provenance always stored (source_url/site/author/license) — CC attribution. Site cover images used as gallery fallback until our renders finish.

| Site | Strategy | Auth |
|---|---|---|
| Thingiverse | Official REST `GET /things/{id}` + `zip_data.files[]/images[]` | user-supplied app token in Settings |
| Printables | Unofficial GraphQL (`print(id:)` + `getDownloadLink` mutation, 24h CDN URLs); queries isolated in one module + contract test vs a known model; cloudscraper fallback hook | none (free models; Club/paid rejected clearly) |
| MakerWorld | **Feature-flagged, shipped last.** Anonymous metadata via `api.bambulab.com/v1/design-service/design/{id}`; downloads need Bambu account Bearer token (email-code MFA login UX, ~90-day token encrypted in settings, expiry banner; presigned URLs ~5 min — fetch instantly). Paid/exclusive rejected. | Bambu account connect flow |

## API surface (all `/api`, session cookie; SSE at `/api/events`)

Auth (login/logout/me) · models CRUD + gallery query (`q` trigram, tags, format, has_sliced, cursor) · revisions (list/create-snapshot/diff) · raw-body `PUT /uploads` · `GET /files/{id}/download` (StreamingResponse) · blob derivatives (`/blobs/{hash}/thumb|glb`, immutable cache headers) · revision assembly thumb · notes · tags · imports (create/poll) · printers (CRUD/test/status/print/pause/resume/stop) · print-jobs · scan (`POST /scan`, scan-runs) · jobs (list/retry) · settings.

## Frontend

**Pinned stack:** React 19.2 · Vite 8 · TS strict · Tailwind 4 (CSS-first, `@tailwindcss/vite`) · shadcn CLI 4 **`-b radix`** (Base UI is the 2026 default — pin the flag) · TanStack Query 5 + TanStack Router · R3F 9.6 + drei 10.7 + three r185.

Routes: `/login` · `/` gallery (card grid: assembly/cover thumb, tag chips, format + print-time badges; debounced search, filter sidebar, infinite scroll) · `/models/:slug` detail (tabs: Files w/ per-file thumb + metadata + download + Print button on sliced; 3D view; Revisions timeline w/ hash-diff + "new revision" staging flow; Notes markdown) · `/upload` drag-drop multi-file streamed PUTs w/ progress + SSE · `/import` URL → preview → file checklist · `/printer` live status panel + history + send dialog (plate picker, AMS/cali toggles) · `/settings` (storage backend + test connection, scan trigger + report resolution UI, site tokens, printer wizard, flags) · `/jobs`.

**Viewer** (~50 lines): `<Canvas frameloop="demand">` + drei `<Stage>` + `<OrbitControls makeDefault enablePan>` (rotate/zoom/pan) + `<Bounds fit clip>` + `useGLTF` with MeshoptDecoder. **GLB only**: STL/OBJ/3MF → glb derivative (preview LOD >1.5M tris); Bambu 3MF server-converted only; sliced `.gcode.3mf` → plate PNG carousel + slice-info panel (no mesh render); STEP → cascadio GLB; IGES → cadquery-ocp GLB; plain gcode → "no preview" card.

## Implementation milestones

**M0 — Repo bootstrap:** `git init`; commit design doc to `docs/superpowers/specs/2026-07-04-3d-model-manager-design.md` (content from this plan + research findings from session scratchpad); project skeleton (backend/, web/, docker/, compose.yaml); CI stub.

**M1 — Core library on local storage (usable: upload/browse/download):** compose skeleton (api/worker/db/redis), full-schema Alembic baseline, auth (argon2id + first-run admin), `StorageBackend` + local impl (FICLONE), streaming PUT + blake3 tee + spool, model/revision/file/tag/note CRUD, layout writer, jobs tracking + SSE, frontend scaffold, Gallery (placeholder thumbs), Model detail, Upload page.
*Accept:* 200 MB STL uploads with progress; rev-002 snapshot near-instant on btrfs; hash-diff correct; on-disk tree matches spec; restart-safe.

**M2 — Pipeline: metadata, thumbs, GLB, viewer:** all extraction/conversion/render jobs, gltfpack + f3d + cascadio + cadquery-ocp in image, derivative endpoints, R3F viewer (rotate/zoom/pan), gallery thumbs + badges, sliced-file plate panel.
*Accept:* STL/OBJ/3MF/STEP/**IGES** each show correct thumb + dims/tris/volume and orbit/pan in the viewer; Bambu Production-Ext 3MF renders; `.gcode.3mf` shows plates + time/filament; 2M-tri STL orbits smoothly.

**M3 — Pluggable storage + scanner:** SMB + S3 backends, settings UI + connection test + local→X migration helper, `scan_library` + report UI (adopt/relink/missing resolution), optional scheduled scan.
*Accept:* Samba share works unprivileged from container; snapshot copy is server-side; out-of-band NAS folder gets adopted as draft model; moved folder relinks by hash without re-hashing unchanged files.

**M4 — Printer (feature-flagged):** `printerd`, adapter over bambulabs-api, setup wizard + Developer-Mode probe, send flow + preflight, live status panel, history, pause/resume/stop.
*Accept:* send `.gcode.3mf` from model page → A1 mini starts; live %/layer/remaining; blocked while RUNNING; SD-missing actionable; app fine with flag off.

**M5 — Importers:** Thingiverse + Printables; import UI; provenance display; MakerWorld behind flag with Bambu login UX.
*Accept:* Printables URL → complete model in library within a minute; Thingiverse via zip_data; MakerWorld free model with connected account; paid rejected clearly; attribution shown.

**M6 — Hardening:** TOFU cert pin, dead-letter UX, backup/restore doc (pg_dump; derivatives regenerable; library is plain files), optional `bambustudio://` deep link, small-file native STL preview in Web Worker, perf pass (1k-model gallery <1s, 50k-file scan), README (Developer Mode + ToS notes).

## Risks (top)

- **Bambu firmware breaks Developer Mode / protocol** → feature flag + adapter + wizard probe + docs pin known-good firmware; app fully useful without printer.
- **MakerWorld ToS/WAF** → last, flagged, token-gated part isolated; browser-extension escape hatch documented.
- **Printables schema drift** → one module + contract tests; imports atomic (model created only on success).
- **OCCT in Docker (STEP/IGES)** → STEP via cascadio (small pip wheel); IGES via cadquery-ocp (~400 MB, pip wheel, shared image layers so paid once); OCCT crashes/leaks contained by the memory-capped, process-recycled `cpu` queue — a bad file kills a task, not the app.
- **Bambu 3MF mis-parse** → lib3mf mandated path + real-file test corpus in CI.
- **Full-snapshot bloat on dumb backends** → user's explicit choice; fast-copy where possible; dedup stats visible; hash model permits future GC without migration.

## Verification

- **Per milestone:** `docker compose up` and drive the acceptance criteria in a real browser (chrome-devtools MCP available for scripted UI verification: upload, gallery render, viewer orbit, revision diff).
- **Backend:** pytest suite per module (storage backends against a temp dir + MinIO + dockerized Samba in CI; importer contract tests against recorded fixtures + one live smoke; sliced-3MF parsing against a corpus of real Bambu Studio exports).
- **Printer:** integration test fixtures for exact `project_file` payload; live test against the actual A1 mini on the LAN for M4 acceptance (user present for first print start).
- **End-to-end drill (M3+):** upload → revision → move folder on share → rescan relinks → download verifies hash.

## Notable judgment calls (flagged for user)

1. **React 19.2 from day one** — greenfield scaffold, so there is no migration cost; 19.2 is simply what M1 scaffolds. It's required by the maintained R3F/drei viewer line (the React-18 line is frozen); TanStack Query 5, shadcn CLI 4, and Tailwind 4 all support it.
2. **IGES preview ships in v1** via cadquery-ocp (~400 MB added to the shared image, paid once thanks to shared layers).
3. **MakerWorld import needs your Bambu account** login (their downloads are token-gated) and is the most fragile importer — shipped last, feature-flagged.
4. **Printer feature requires enabling Developer Mode** on the A1 mini (disconnects it from Bambu Cloud/Handy while in LAN-only mode).
