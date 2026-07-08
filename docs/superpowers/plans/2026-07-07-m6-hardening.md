# M6 Implementation Plan — Hardening (secrets · reliability · correctness · perf · UX)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the M6 "hardening" milestone the way the user demanded it — THOROUGH, no minimal-scope cuts, no in-scope deferrals. Concretely: (U1) a non-mm 3MF (e.g. `unit="meter"`) yields correct `dims_mm`/`volume_cm3`/`surface_area_cm2` **and** a correctly-scaled GLB derivative, preserving the project's "1 GLB unit = 1 mm" invariant; (A1) SMB/S3 storage credentials and the Thingiverse import token are **encrypted at rest** (Fernet, mirroring the M4 printer key), with existing plaintext rows **eagerly re-encrypted at startup** (not lazily), and API responses still redacted; (A2) every secret field is a pydantic `SecretStr` (including `SmbConfig`/`S3Config`, via `field_serializer`s so `model_dump()`→JSONB/Celery still round-trips) and `PrinterConnection.access_code` no longer prints in a `repr`; (B1) `import_from_url` is **re-entry idempotent** under `acks_late` redelivery — no duplicate model, no orphan, no import stuck `downloading`; (B2) `printerd` **reconciles** enabled printers without a restart and tears down a since-disabled printer's worker **cleanly** (no leaked pubsub thread); (B3) a real **Jobs page** replaces the `ComingSoon` stub AND a formal **dead-letter state** (retry ceiling + `Job.max_attempts` column + auto-park) lands with its migration + drift-guard; (B4) an **"Add files"** action on the model detail page uploads into the current revision through the existing `PUT /api/uploads` seam; (D1) the gallery serves **1k models in < 1s** via the missing keyset/filter indexes + a bulk-seed harness + a measured assertion; (D2) a **50k-file scan** stops doing ~6 sync round-trips per unknown file (batch-preload + chunked commits) with a query-count-bounded + wall-clock harness; (C1) a **Backup & Restore** doc (pg_dump + the `tdmm_data` `/data` volume **including `secrets/` Fernet keys** + derivatives-are-regenerable + library-is-plain-files); (C2) the vendored-`bambulabs_api` `ssl.PROTOCOL_TLS` `DeprecationWarning` is filtered so the gate output stays pristine; (C3) four test-hygiene folds land; plus the cheap deferred minors folded in (review_state gallery badge + dismiss; `usePrinterStatus` stop-poll on terminal; migrate `mark_done`-after-cutover UX).

**Architecture:** No new architectural layer — M6 hardens the layers M1–M5 built. The touch-points are the seams the two surface maps pinned exactly:
- **Secrets** ride the already-generic `app/crypto.py` Fernet functions (`encrypt_secret`/`decrypt_secret` operate on bare strings) and the same key at `{data_dir}/secrets/printer.key` shared across api/worker/printerd via `tdmm_data:/data`. A1 puts encrypt-on-write / decrypt-on-use at the **two** centralized config seams M3 already funnels every backend-resolution through (`storage_config.get_active_config[_sync]` / `set_active_config[_sync]`) plus the import-token accessor, and an idempotent **startup re-encryption** pass in the API lifespan upgrades legacy plaintext rows. A2 changes field *types* to `SecretStr` and adds `field_serializer`s so the same `model_dump()` calls A1 relies on keep emitting JSON-serializable strings.
- **U1** fixes the single shared `meshload.load_mesh` / `load_3mf_lib3mf` loader, so both `_mesh_blob_meta` (metadata) and `convert_to_glb_file` (GLB) get the correction for free.
- **B1/B2** mirror M3's scanner reliability idioms (`scan.py`'s Redis singleton lock; "always re-derive from the source of truth" reconciliation).
- **B3** reuses the generic `jobs` table + existing `GET /api/jobs` / `POST /api/jobs/{id}/retry` endpoints (adds one column + one dead state), and builds the greenfield Jobs page against them.
- **D1/D2** add indexes + batch DB access + build the missing bulk-seed test harnesses (none exist today).

**Tech Stack:** No new runtime dependency. Backend: FastAPI + SQLAlchemy 2 async (asyncpg) + Celery/Redis + PostgreSQL 16; `cryptography.Fernet` (already a dep, M4); `trimesh` + `lib3mf` (already deps, M2). Frontend: React 19 + Vite + TS strict + Tailwind + shadcn/Radix + TanStack Query/Router. Tests: real Postgres + Redis testcontainers + real Alembic migrations (hard rule, unchanged); Celery eager; `httpx.MockTransport` for importer HTTP (M5 carve-out). Stack pins exactly as M5 left them (`uv.lock` unchanged unless a task explicitly says otherwise — no task in M6 adds a dependency).

## Global Constraints (bind every task)

- **Git identity (MANDATORY, security-relevant):** every execution commit is authored by the repo-local git config as `metril <1517921+metril@users.noreply.github.com>`. NEVER a real name/email. NEVER add `Co-Authored-By`, "Generated with", or any AI-attribution trailer of any kind, ever.
- **Branch:** all M6 work on `feat/m6-hardening` (branched from `main` at base commit `916c9ac`).
- **Lean reviews (per `[[sdd-review-intensity]]`):** NO per-task reviewer subagents. The controller diff-skims each task (stat + risky files) and relies on the implementer's self-review + RED/GREEN evidence. A **DEDICATED reviewer runs ONLY on the three secrets/idempotency tasks: Task 2 (A1), Task 3 (A2), Task 4 (B1)** — each flagged **[DEDICATED REVIEW]** in its header. Exactly ONE whole-branch review + ONE fix wave at milestone close.
- **Quality gates (every code task):** backend `uv run ruff check .` + `uv run ruff format --check .` clean; `uv run pytest` green with **pristine output** (no stray warnings/log noise in the summary — this is why C2 exists); web `npm run build` (tsc strict) green, `npm run lint` clean, `npm test` green. TDD required for every backend/frontend logic task: failing test first, RED/GREEN evidence in the task report. Run backend commands from `backend/`, web commands from `web/`.
- **Default test gate stays `-m 'not e2e and not live_importer'`.** No task changes `addopts`. The perf harnesses (D1/D2) run in the default gate (real testcontainers, in-process) — they are NOT marked `e2e`/`live_importer`; keep their thresholds CI-safe (generous wall-clock margins; assert query-count invariants, which are machine-independent, as the primary signal).
- **Real infra in tests (hard rule, unchanged):** PostgreSQL + Redis via testcontainers; real Alembic migration applied; Celery eager. Never `moto`/mock-SMB/S3/SQLite/fakeredis.
- **Every Alembic migration ships with its drift-guard.** `backend/tests/test_migration_drift.py::test_models_match_migrations_exactly` (Alembic `compare_metadata` against the real migrated DB) already auto-covers ANY model/migration divergence — a migration task is not done until that test is green, AND (for named indexes) `backend/tests/test_migrations.py`'s `EXPECTED_INDEXES` set is extended. Two migrations land in M6: **D1** (Task 7, gallery indexes) chains off head `793658394a4d`; **B3a** (Task 8, dead-letter column) chains off D1's revision. Each is scaffolded with `uv run alembic revision -m "..."` (auto-sets `down_revision` to the current head — run `uv run alembic heads` first to confirm), then the `upgrade()`/`downgrade()` bodies are filled by hand (precedent: `793658394a4d_add_model_review_state.py`).
- **Secrets never widen a response.** After A1/A2, `GET /api/settings/storage` and `GET /api/settings/import-tokens` STILL return the `"***"` sentinel (never plaintext, never ciphertext). The decrypted plaintext is used only to build a backend/`Authorization` header, never logged/returned/placed in `imports.meta`/`error`/`job.error`.
- **`convert_units("millimeters", guess=False)` is safe to call unconditionally** on any trimesh-parsed 3MF (units default to `"millimeter"`, factor 1.0 → no-op), and factor 1.0 lib3mf-`apply_scale` is a no-op — verified against the real corpus fixture (surface map U1). STL/OBJ never reach the 3MF branch, so they are structurally untouched.
- **No lazy secret upgrade.** A1 re-encrypts existing plaintext rows **eagerly** at API startup (idempotent), not "next time someone re-saves settings." Reads keep an `InvalidToken`→use-plaintext fallback purely as a belt-and-suspenders for the window before the upgrade pass runs; that fallback never itself writes.

## Backlog Triage Table

Every in-scope item maps to exactly one task; every deferred item carries its reason.

| Item | Source | Disposition |
|---|---|---|
| **U1** 3MF unit normalization (meshload loader; BlobMeta + GLB) | correctness map §U1 | **Task 1** |
| **A1** encrypt SMB/S3 storage secrets + Thingiverse token at rest (eager re-encrypt) | secrets map §A1 | **Task 2** [DEDICATED] |
| **A2** SecretStr all secret fields incl. `SmbConfig`/`S3Config` + `repr=False` on `access_code` | secrets map §A2 | **Task 3** [DEDICATED] |
| **B1** `import_from_url` re-entry idempotency (early link + orphan-detect + Redis lock) | secrets map §B1 | **Task 4** [DEDICATED] |
| **B2** printerd reconciliation loop + clean per-printer thread stop | secrets map §B2 | **Task 5** |
| **D1** gallery indexes + 1k-seed harness + <1s measurement | correctness map §D1 | **Task 7** (migration + drift-guard) |
| **D2** scanner N+1 batching + tx checkpointing + 50k-seed harness | correctness map §D2 | **Task 6** |
| **B3-B** dead-letter STATE (retry ceiling + `Job.max_attempts` + auto-park) | secrets map §B3 | **Task 8** (migration + drift-guard) |
| migrate `mark_done`-after-cutover UX (M3 deferred minor) | ledger M3 | **Task 8** (folded — same file, job-state theme) |
| **B3-A** build the Jobs page (replace `/jobs` ComingSoon) + list/retry hooks | secrets map §B3 | **Task 9** |
| **B4** "Add files" on model detail → current revision via `PUT /api/uploads` | correctness map §B4 | **Task 10** |
| review_state gallery "needs review" badge + dismiss (expose on ModelSummary/ModelDetail) | ledger M3/M4 fold | **Task 11** |
| `usePrinterStatus` stop-poll on terminal `gcode_state` (M4 deferred minor #3) | ledger M4 | **Task 11** (folded) |
| **C2** paho `ssl.PROTOCOL_TLS` DeprecationWarning filterwarnings | correctness map §C2 | **Task 12** |
| **C3a** registry `get_backend` smb/s3 factory-path unit test | correctness map §C3a | **Task 12** |
| **C3b** fast stub test for the UNKNOWN-guard + `_dump_get` nested fallback | correctness map §C3b | **Task 12** |
| **C3c** Thingiverse contract test's real-empty-session leak (local autouse override) | correctness map §C3c | **Task 12** |
| **C3d** blank import-token PUT writing a null `Setting` row | correctness map §C3d | **Task 12** |
| **C1** Backup/Restore doc (pg_dump + `/data` incl. Fernet keys + regenerables) | correctness map §C1 | **Task 13** (docs-only) |
| TOFU cert pinning for printer TLS | spec M6 | **DEFERRED** — needs the live A1-mini self-signed cert to design/verify the pin; pair with the deferred **live-A1 physical acceptance**. Cannot be TDD'd headless. |
| small-file native STL preview in a Web Worker | spec M6 | **DEFERRED** — a viewer *feature*, not hardening; no correctness/reliability payoff; out of the confirmed M6 scope. |
| `bambustudio://` open-in-slicer deep link | spec M6 | **DEFERRED** — a *feature* (printarr-lesson nicety), not hardening; out of confirmed scope. |
| optional IGES via cadquery-ocp build flag | spec M6 | **DEFERRED** — IGES already ships in v1 (spec lines 27/170/202); the "build flag" is an image-size optimization, not hardening; no in-scope trigger. |
| M4 live-A1 physical acceptance; M5 Thingiverse `zip_data` live verify | ledger M4/M5 | **NOTE, not a task** — both require live hardware/credentials (deferred, user-present); paired with the TOFU-pin deferral above. |
| M3 S3-walk pathological "file==dir-prefix" key guard | ledger M3 | **DEFERRED** — documented non-issue; our own writes physically can't produce it; YAGNI. |
| M3 scan Redis-lock renewal for multi-hour scans (F4) | ledger M3 | **DEFERRED** — DB running-state guard is the real backstop; worst case is a clean IntegrityError-failed scan, never corruption (review-accepted). |
| M3 `patch_model` sidecar/commit atomicity (F5) | ledger M3 | **DEFERRED** — self-heals via the scanner's sidecar-refresh; no action. |
| M5-Minor2 importer double-fetch metadata efficiency | ledger M5 | **DEFERRED** — correctness-neutral; add a per-import cache only if live rate-limits bite. |
| M5-Minor3 `safe_filename` collision (`a/x.stl`+`b/x.stl`) | ledger M5 | **DEFERRED** — rare; currently a clean FAILED (no orphan/leak); a de-dup suffix is a future nicety. |

---

## Task 1: U1 — Normalize non-mm 3MF units to millimetres at the `meshload` seam

Correctness map §U1 (root cause empirically verified against `backend/tests/corpus_real/DotC parts - Part 2.3mf`, `unit="meter"`). Fix the ONE shared loader (`backend/app/pipeline/meshload.py`) so BOTH `_mesh_blob_meta` (metadata: `dims_mm`/`volume_cm3`/`surface_area_cm2`) AND `convert_to_glb_file` (the GLB derivative) get correct mm-scale geometry — neither reads the `<model unit>` today. Preserves "1 GLB unit = 1 mm" without touching the STEP/IGES branches. No migration; pure logic.

**Files:**
- Modify: `backend/app/pipeline/meshload.py`
- Modify: `backend/tests/corpus.py` (add a meter-unit synthetic fixture), `backend/tests/test_pipeline_metadata.py`, `backend/tests/test_pipeline_convert.py`, `backend/tests/test_real_corpus.py`

**Interfaces:** no signature changes. `load_mesh(path, fmt) -> MeshLoad` and `load_3mf_lib3mf(path) -> trimesh.Trimesh` keep their signatures; the correction is internal and format-scoped to `BlobFormat.THREEMF`.

- [ ] **Step 1 — RED: synthetic meter-unit fixture + loader test.** In `backend/tests/corpus.py`, add a meter-unit 3MF builder alongside `box_3mf_generic` (which hardcodes `unit="millimeter"`). It is the SAME physical 20×10×5 mm box, described in metres (coordinates ÷ 1000, `unit="meter"`):
  ```python
  def box_3mf_meter() -> bytes:
      """A 20x10x5 mm box described in METRES (unit="meter", coords /1000) --
      the U1 regression fixture: a correct loader must scale it back to mm."""
      return _build_3mf(unit="meter", scale=0.001)  # mirror box_3mf_generic's builder, parametrized
  ```
  (Follow `box_3mf_generic`'s existing construction verbatim; only `unit=` and the vertex scale change — if the current builder inlines `unit="millimeter"`, factor it into a small `_build_3mf(unit, scale)` helper the two share.) Then in `backend/tests/test_pipeline_metadata.py` add:
  ```python
  def test_load_mesh_3mf_meter_unit_normalizes_to_mm():
      load = meshload.load_mesh(corpus.box_3mf_meter(), BlobFormat.THREEMF)  # writes bytes to a temp file per the existing helper
      assert load.mesh.extents == pytest.approx((20.0, 10.0, 5.0), abs=1e-3)
  ```
  (Match how the sibling `test_load_mesh_native_formats_use_trimesh` obtains a `Path` from corpus bytes — use the same temp-file helper.) Run `uv run pytest tests/test_pipeline_metadata.py -k meter -q` → **RED**: `assert (0.02, 0.01, 0.005) == approx((20.0, 10.0, 5.0))`.

- [ ] **Step 2 — GREEN: trimesh branch.** In `meshload.py`, in `load_mesh`'s THREEMF path, normalize before returning. Replace lines 62-69 with:
  ```python
      mesh: trimesh.Trimesh | None = None
      try:
          mesh = to_single_mesh(trimesh.load(path))
      except Exception:  # noqa: BLE001 - any load failure means "fall back to lib3mf"
          mesh = None
      if mesh is not None and len(mesh.faces) > 0:
          # Apply the 3MF <model unit> attribute trimesh parsed but never
          # applies (units default to "millimeter" per the 3MF spec, so this
          # is a no-op factor 1.0 for the common case; guess=False raises a
          # clear ValueError on a non-spec unit string rather than silently
          # mis-scaling -- U1, correctness map). Fixes BOTH dims/volume/area
          # AND the GLB derivative, since convert_to_glb_file uses this loader.
          mesh.convert_units("millimeters", guess=False)
          return MeshLoad(mesh, "trimesh")
      return MeshLoad(load_3mf_lib3mf(path), "lib3mf")
  ```
  Run the Step-1 test → **GREEN**.

- [ ] **Step 3 — RED+GREEN: lib3mf branch.** Add a Production-Extension-style meter-unit test (mirror `test_load_3mf_lib3mf_direct`) that drives `load_3mf_lib3mf` directly, asserting `extents == pytest.approx((20.0, 10.0, 5.0), abs=1e-3)`. Then in `meshload.py` add the unit-factor table and apply it in `load_3mf_lib3mf`:
  ```python
  # lib3mf.ModelUnit codes (Lib3MF.py): MicroMeter=0 .. Meter=5 -> mm-per-unit.
  _LIB3MF_UNIT_TO_MM = {0: 0.001, 1: 1.0, 2: 10.0, 3: 25.4, 4: 304.8, 5: 1000.0}
  ```
  and, after `reader.ReadFromFile(str(path))` and the concatenate, before returning:
  ```python
      factor = _LIB3MF_UNIT_TO_MM.get(int(model.GetUnit()), 1.0)
      merged = trimesh.util.concatenate(meshes)
      if factor != 1.0:
          merged.apply_scale(factor)  # normalize to mm (no-op for MilliMeter)
      return merged
  ```
  (Replace the existing `return trimesh.util.concatenate(meshes)` tail.) Run `uv run pytest tests/test_pipeline_metadata.py -q` → GREEN.

- [ ] **Step 4 — RED+GREEN: full pipeline step + GLB conversion.** (a) Mirror `test_extract_metadata_native_mesh_formats` with `box_3mf_meter()` through `pipeline._extract_metadata_step`, asserting `meta.dims_mm == pytest.approx([20.0, 10.0, 5.0])`, `meta.volume_cm3 == pytest.approx(1.0)`, `meta.surface_area_cm2 == pytest.approx(7.0)`. (b) In `backend/tests/test_pipeline_convert.py`, extend the parametrized `test_convert_to_glb_file_every_format_branch` with the `box_3mf_meter()` case, asserting the exported GLB's `mesh.extents == pytest.approx((20.0, 10.0, 5.0), abs=1e-3)` — this proves the "not just metadata" half (the GLB derivative itself now carries correct mm-scale geometry). Both should already pass once Steps 2-3 land (they ride the same loader); if the convert test needs the format registered, follow the parametrization's existing pattern.

- [ ] **Step 5 — RED+GREEN: real-fixture regression (the prompt's literal ask).** In `backend/tests/test_real_corpus.py`, add a dedicated non-dynamic test referencing the committed fixture by name:
  ```python
  def test_dotc_part2_meter_unit_3mf_dims_are_mm():
      path = corpus_real_dir() / "DotC parts - Part 2.3mf"  # git-tracked; unit="meter"
      load = meshload.load_mesh(path, BlobFormat.THREEMF)
      # empirically-derived correct mm extents (correctness map U1); precise
      # assertion since the fixture is a fixed committed binary that won't drift.
      assert load.mesh.extents == pytest.approx((6.4495, 6.44976, 2.8), rel=1e-3)
  ```
  RED before Steps 2-3 (would read ~0.0064), GREEN after. If `corpus_real_dir()` isn't already exposed by the test module, reuse whatever path helper `_make_project_3mf_test` uses.

- [ ] **Step 6 — accepted-tradeoff note + gates.** In the loader docstring, note the behavior change: a 3MF with a **non-spec unit string** now raises a clear `ValueError` at extract/convert time (via `guess=False`) instead of silently mis-scaling — a correctness improvement, but a previously-"succeeding" pathological upload could newly fail (none in the corpus; accepted per correctness map U1). **Backfill note (do NOT build machinery):** any meter-unit 3MF ingested before this fix keeps a wrong `BlobMeta` + GLB under the skip-if-exists idempotency; re-upload (or manual `BlobMeta`+`Derivative` row deletion) is required to reprocess — document this one-liner in the commit body only. Full `uv run pytest` green; ruff clean.

- [ ] **Step 7 — commit.** `git add -A && git commit -m "Normalize non-mm 3MF units to millimetres in the meshload loader (fixes dims/volume/area and GLB scale)"`.

**Accept:** a meter-unit 3MF (synthetic `box_3mf_meter` and the real `DotC parts - Part 2.3mf`) loads with correct mm extents through BOTH the trimesh and lib3mf branches; `_extract_metadata_step` yields correct `dims_mm`/`volume_cm3`/`surface_area_cm2`; the GLB derivative carries correct mm geometry; STL/OBJ (unitless) and mm-unit 3MF are provably unaffected (existing tests stay green); a non-spec unit string fails loudly rather than silently mis-scaling.

---

## Task 2: A1 — Encrypt SMB/S3 storage secrets + the Thingiverse import token at rest (eager re-encryption) **[DEDICATED REVIEW]**

Secrets map §A1 (medium-high risk, secrets-at-rest class → dedicated review, mirroring M4 Task 1's crypto review). Today the SMB `password` / S3 `secret_key` sit **plaintext** in the `settings` JSONB row, and the Thingiverse token is plaintext in its own `settings` row — readable by anyone with DB access or a `pg_dump`. Reuse the M4 Fernet seam (`app/crypto.py`, already backend-agnostic — operates on bare strings) to encrypt-on-write / decrypt-on-use at the **centralized** config seams M3 already funnels through, and **eagerly re-encrypt** legacy plaintext rows at API startup. API responses stay redacted. Same key at `{data_dir}/secrets/printer.key`, shared across api+worker (confirmed cross-container via `tdmm_data:/data`).

**Files:**
- Modify: `backend/app/storage/config.py` (own the shared secret-field map), `backend/app/services/storage_config.py` (encrypt/decrypt seam + `settings` param), `backend/app/services/import_tokens.py` (encrypt/decrypt + `settings` param), `backend/app/api/settings.py` (thread `settings`; import the shared map), `backend/app/tasks/migrate.py` (decrypt the Celery target arg; thread `settings` to cutover)
- Create: `backend/app/services/secrets_at_rest.py` (the idempotent startup re-encryption pass), `backend/tests/test_secrets_at_rest.py`
- Modify: `backend/app/main.py` (call the startup pass in the lifespan), `backend/tests/test_storage_config.py`, `backend/tests/test_settings_api.py`, `backend/tests/test_migrate_task.py`, `backend/tests/test_import_tokens_api.py`

**Interfaces (consumed by later callers — keep exact):**
- `app/storage/config.py`: `SECRET_FIELD_BY_BACKEND: dict[str, str] = {"smb": "password", "s3": "secret_key"}` (single owner; `api/settings.py` imports it instead of its local `_SECRET_FIELD`).
- `app/services/storage_config.py`:
  ```python
  async def get_active_config(db: AsyncSession, settings: Settings) -> StorageConfig      # NEW settings param
  def get_active_config_sync(session: Session, settings: Settings) -> StorageConfig        # NEW settings param
  async def set_active_config(db: AsyncSession, settings: Settings, config: StorageConfig) -> None
  def set_active_config_sync(session: Session, settings: Settings, config: StorageConfig) -> None
  def encrypt_config_secret(settings: Settings, config: StorageConfig) -> dict             # model_dump with the secret field Fernet-wrapped
  def decrypt_config_row(settings: Settings, data: dict) -> tuple[dict, bool]              # (decrypted, was_plaintext)
  # resolve_backend[_sync] unchanged signature -- already receive settings, just pass down.
  ```
- `app/services/import_tokens.py`:
  ```python
  async def get_import_tokens(db, settings: Settings) -> ImportTokens                      # NEW settings param (decrypt)
  def get_import_tokens_sync(session, settings: Settings) -> ImportTokens                   # NEW settings param (decrypt)
  async def set_thingiverse_token(db, settings: Settings, token: str | None) -> None        # NEW settings param (encrypt)
  ```
- `app/services/secrets_at_rest.py`: `async def reencrypt_secrets_at_rest(db: AsyncSession, settings: Settings) -> None` (idempotent; called once at startup).

- [ ] **Step 1 — own the shared secret-field map.** In `backend/app/storage/config.py`, add near the top (after the config classes): `SECRET_FIELD_BY_BACKEND = {"smb": "password", "s3": "secret_key"}`. In `backend/app/api/settings.py`, delete the local `_SECRET_FIELD` and `from app.storage.config import SECRET_FIELD_BY_BACKEND`, replacing the two `_SECRET_FIELD.get(...)` uses. (Pure move; run the settings suite to confirm no behavior change.)

- [ ] **Step 2 — RED: the round-trip + legacy-plaintext test.** Create `backend/tests/test_secrets_at_rest.py`:
  ```python
  import pytest
  from app.config import get_settings
  from app.models import Setting
  from app.services import storage_config
  from app.services.secrets_at_rest import reencrypt_secrets_at_rest
  from app.storage.config import SmbConfig


  @pytest.mark.asyncio
  async def test_set_active_config_writes_ciphertext_not_plaintext(db_session):
      s = get_settings()
      cfg = SmbConfig(host="h", share="sh", username="u", password="hunter2")
      await storage_config.set_active_config(db_session, s, cfg)
      row = await db_session.get(Setting, "storage")
      assert row.value["password"] != "hunter2"          # ciphertext at rest
      back = await storage_config.get_active_config(db_session, s)
      assert back.password == "hunter2"                   # decrypts on read

  @pytest.mark.asyncio
  async def test_legacy_plaintext_row_reads_and_gets_reencrypted(db_session):
      s = get_settings()
      # simulate a pre-M6 install: a plaintext secret written straight to JSONB
      db_session.add(Setting(key="storage", value={
          "backend": "smb", "host": "h", "share": "sh", "root": "",
          "username": "u", "password": "plaintext123", "port": 445, "encrypt": True}))
      await db_session.commit()
      # read still works (InvalidToken -> use-as-is fallback)
      cfg = await storage_config.get_active_config(db_session, s)
      assert cfg.password == "plaintext123"
      # eager upgrade re-encrypts it at rest
      await reencrypt_secrets_at_rest(db_session, s)
      row = await db_session.get(Setting, "storage")
      assert row.value["password"] != "plaintext123"
      assert (await storage_config.get_active_config(db_session, s)).password == "plaintext123"
  ```
  Run `uv run pytest tests/test_secrets_at_rest.py -q` → RED (`get_active_config` takes no `settings`; module missing).

- [ ] **Step 3 — GREEN: the encrypt/decrypt seam.** Rewrite `backend/app/services/storage_config.py`:
  ```python
  from cryptography.fernet import InvalidToken
  from app.crypto import decrypt_secret, encrypt_secret
  from app.storage.config import (
      LocalConfig, SmbConfig, S3Config, StorageConfig,  # noqa: F401 (S3Config for callers)
      SECRET_FIELD_BY_BACKEND, parse_storage_config,
  )

  def encrypt_config_secret(settings: Settings, config: StorageConfig) -> dict:
      """model_dump the config with its secret field Fernet-encrypted (or a
      no-op for LocalConfig / an unset secret)."""
      data = config.model_dump()
      field = SECRET_FIELD_BY_BACKEND.get(data.get("backend"))
      if field and data.get(field):
          data[field] = encrypt_secret(settings, data[field])
      return data

  def decrypt_config_row(settings: Settings, data: dict) -> tuple[dict, bool]:
      """Decrypt the stored secret in-place; second element is True when the
      value wasn't Fernet ciphertext yet (a pre-M6 plaintext row) so the
      startup upgrade knows to re-write it. A non-Fernet string raises
      InvalidToken -> treat as already-plaintext (secrets map A1.4)."""
      field = SECRET_FIELD_BY_BACKEND.get(data.get("backend"))
      if not field or not data.get(field):
          return data, False
      try:
          data[field] = decrypt_secret(settings, data[field])
          return data, False
      except InvalidToken:
          return data, True

  async def get_active_config(db: AsyncSession, settings: Settings) -> StorageConfig:
      row = await db.get(Setting, SETTINGS_KEY)
      if row is None:
          return LocalConfig()
      data, _ = decrypt_config_row(settings, dict(row.value))
      return parse_storage_config(data)

  def get_active_config_sync(session: Session, settings: Settings) -> StorageConfig:
      row = session.get(Setting, SETTINGS_KEY)
      if row is None:
          return LocalConfig()
      data, _ = decrypt_config_row(settings, dict(row.value))
      return parse_storage_config(data)

  async def set_active_config(db: AsyncSession, settings: Settings, config: StorageConfig) -> None:
      value = encrypt_config_secret(settings, config)
      row = await db.get(Setting, SETTINGS_KEY)
      if row is None:
          db.add(Setting(key=SETTINGS_KEY, value=value))
      else:
          row.value = value
      await db.commit()

  def set_active_config_sync(session: Session, settings: Settings, config: StorageConfig) -> None:
      value = encrypt_config_secret(settings, config)
      row = session.get(Setting, SETTINGS_KEY)
      if row is None:
          session.add(Setting(key=SETTINGS_KEY, value=value))
      else:
          row.value = value
      session.commit()

  async def resolve_backend(db: AsyncSession, settings: Settings) -> StorageBackend:
      return get_backend(settings, await get_active_config(db, settings))

  def resolve_backend_sync(session: Session, settings: Settings) -> StorageBackend:
      return get_backend(settings, get_active_config_sync(session, settings))
  ```
  (`dict(row.value)` copies so the in-place decrypt never mutates the ORM-tracked JSONB — the getter must NOT write.) The 7 USE call sites already call `resolve_backend[_sync](x, settings)` — no change there.

- [ ] **Step 4 — GREEN: import-token encryption.** Rewrite `backend/app/services/import_tokens.py`'s accessors to take `settings` and encrypt/decrypt:
  ```python
  from cryptography.fernet import InvalidToken
  from app.config import Settings
  from app.crypto import decrypt_secret, encrypt_secret

  def _decrypt_token(settings: Settings, value: dict | None) -> ImportTokens:
      if not value or not value.get("thingiverse_token"):
          return ImportTokens()
      raw = value["thingiverse_token"]
      try:
          return ImportTokens(thingiverse_token=decrypt_secret(settings, raw))
      except InvalidToken:
          return ImportTokens(thingiverse_token=raw)  # legacy plaintext

  async def get_import_tokens(db, settings: Settings) -> ImportTokens:
      row = await db.get(Setting, SETTINGS_KEY)
      return _decrypt_token(settings, row.value if row else None)

  def get_import_tokens_sync(session, settings: Settings) -> ImportTokens:
      row = session.get(Setting, SETTINGS_KEY)
      return _decrypt_token(settings, row.value if row else None)

  async def set_thingiverse_token(db, settings: Settings, token: str | None) -> None:
      stored = encrypt_secret(settings, token) if token else None
      value = {"thingiverse_token": stored}
      row = await db.get(Setting, SETTINGS_KEY)
      if row is None:
          db.add(Setting(key=SETTINGS_KEY, value=value))
      else:
          row.value = value
      await db.commit()
  ```
  (C3d's "blank PUT writes a null row" is fixed separately in Task 12 — leave the create-on-`None` behavior here as-is so this task stays scoped to encryption.)

- [ ] **Step 5 — GREEN: the eager startup pass.** Create `backend/app/services/secrets_at_rest.py`:
  ```python
  """Idempotent, EAGER re-encryption of any legacy plaintext secret at rest
  (M6 A1). Called once from the API lifespan on startup -- NOT lazily on the
  next settings-save. The api/worker/printerd containers share the same DB and
  the same Fernet key (tdmm_data:/data), so upgrading once from the api process
  encrypts the shared rows for every process."""
  from __future__ import annotations

  from cryptography.fernet import InvalidToken
  from sqlalchemy.ext.asyncio import AsyncSession

  from app.config import Settings
  from app.crypto import decrypt_secret, encrypt_secret
  from app.models import Setting
  from app.services import storage_config
  from app.storage.config import SECRET_FIELD_BY_BACKEND, parse_storage_config


  async def reencrypt_secrets_at_rest(db: AsyncSession, settings: Settings) -> None:
      changed = False
      storage_row = await db.get(Setting, "storage")
      if storage_row is not None:
          data, was_plaintext = storage_config.decrypt_config_row(settings, dict(storage_row.value))
          if was_plaintext:
              storage_row.value = storage_config.encrypt_config_secret(settings, parse_storage_config(data))
              changed = True
      token_row = await db.get(Setting, "import_tokens")
      if token_row is not None:
          token = (token_row.value or {}).get("thingiverse_token")
          if token:
              try:
                  decrypt_secret(settings, token)  # already ciphertext -> no-op
              except InvalidToken:
                  token_row.value = {**token_row.value, "thingiverse_token": encrypt_secret(settings, token)}
                  changed = True
      if changed:
          await db.commit()
  ```
  In `backend/app/main.py`'s lifespan, after `ensure_admin_user(session)` and inside the same `async with ... as session:` block, add:
  ```python
      from app.services.secrets_at_rest import reencrypt_secrets_at_rest
      await reencrypt_secrets_at_rest(session, get_settings())
  ```
  Run `uv run pytest tests/test_secrets_at_rest.py -q` → GREEN.

- [ ] **Step 6 — thread `settings` through the API + migrate.** In `backend/app/api/settings.py`: add `settings: Settings = Depends(get_settings)` to `get_storage_settings`, `put_storage_settings`, and `migrate_storage_settings` (`test_storage_settings` already has it); pass `settings` to `storage_config.get_active_config(db, settings)` / `set_active_config(db, settings, config)` and to `_merge_stored_secrets(db, settings, ...)` (add the param there, forwarding to its internal `get_active_config` call). Change the migrate dispatch to encrypt the target on the wire (secrets map A1.5.2 — the target config currently travels plaintext over the internal broker):
  ```python
      migrate_storage.apply_async(
          args=[str(job.id), storage_config.encrypt_config_secret(settings, config)],
          task_id=str(job.id),
      )
  ```
  In `backend/app/tasks/migrate.py`: thread `settings` and decrypt the incoming (now-ciphertext) target arg at the top, and pass `settings` to the cutover:
  ```python
      settings = get_settings()
      data, _ = storage_config.decrypt_config_row(settings, dict(target))
      target_cfg = parse_storage_config(data)
      ...
          set_active_config_sync(s, settings, target_cfg)  # cutover encrypts on write
  ```
  (Import `from app.services import storage_config` and `from app.services.storage_config import resolve_backend_sync, set_active_config_sync`.)

- [ ] **Step 7 — RED→GREEN: extend the existing suites for the new arg + ciphertext-at-rest.** Update every direct caller of the changed signatures in tests:
  - `test_storage_config.py`, `test_settings_api.py`, `test_migrate_task.py`: pass `get_settings()` to `get_active_config[_sync]` / `set_active_config[_sync]` calls (secrets map lists the exact lines: `test_settings_api.py` ~184/217/256/289/336; `test_migrate_task.py` ~50/121). Extend the existing `PUT /storage → GET /storage` test to additionally assert the raw DB row is ciphertext: after a `PUT`, `row = await db_session.get(Setting, "storage"); assert row.value["password"] != "<the submitted secret>"` while `GET /storage` still returns `"***"`.
  - `test_migrate_task.py`: after a successful cutover, assert `(await get_active_config_sync(...)).secret_key == "<real>"` AND the raw `Setting` row is ciphertext.
  - `test_import_tokens_api.py`: PUT a real token, then assert `(await db_session.get(Setting, "import_tokens")).value["thingiverse_token"] != "<real token>"` and `GET /import-tokens` still returns `"***"`.
  Run each suite → RED where the `settings` arg is missing / plaintext asserted, then GREEN.

- [ ] **Step 8 — crypto docstring note (no rename churn).** In `backend/app/crypto.py`, update the module docstring's opening to note the key now protects storage secrets + the import token as well as printer access codes ("Fernet encryption for at-rest secrets — printer access codes, SMB/S3 storage credentials, and the Thingiverse import token — all under one key at `{data_dir}/secrets/printer.key`"). Keep `printer_key_path`'s name (rename is pure churn; a leaked key already means full compromise via the printer path).

- [ ] **Step 9 — full gates.** `uv run pytest` green (the whole suite exercises `resolve_backend[_sync]` heavily — a threading miss surfaces loudly); ruff + format clean.

- [ ] **Step 10 — commit.** `git add -A && git commit -m "Encrypt SMB/S3 storage secrets and the Thingiverse token at rest (Fernet), with eager startup re-encryption of legacy plaintext rows"`.

**[DEDICATED REVIEW]** — verify: (1) `GET /storage` and `GET /import-tokens` STILL redact (`"***"`), never plaintext/ciphertext; (2) round-trip correctness (write→ciphertext-at-rest→read→plaintext) for smb, s3, and token; (3) the legacy-plaintext `InvalidToken` fallback reads correctly AND the startup pass re-encrypts it idempotently (a second startup pass writes nothing); (4) the getter never writes (decrypt on a copied dict); (5) the migrate target travels encrypted and decrypts at the task; (6) no plaintext lands in `imports.error`/`job.error`/logs.

**Accept:** SMB/S3 secrets and the Thingiverse token are Fernet-encrypted in the `settings` JSONB; a pre-M6 plaintext install reads correctly and is eagerly re-encrypted on the next API start; all API responses stay redacted; the migrate target is encrypted on the broker and decrypted on use; one Fernet key under `{data_dir}/secrets` serves all three secret classes across api/worker/printerd.

---

## Task 3: A2 — `SecretStr` for every secret field (incl. `SmbConfig`/`S3Config`) + `repr=False` on `access_code` **[DEDICATED REVIEW]**

Secrets map §A2. In-memory `repr()`/traceback/log hardening on top of A1's at-rest encryption. Wraps the three `Settings` fields, the two storage-config secret fields, and neutralizes the `PrinterConnection.access_code` dataclass repr. Sequenced strictly **after A1** because both touch `storage_config.py`/`config.py` and A2's `field_serializer` must keep A1's `model_dump()`→`encrypt_config_secret`→JSONB path emitting plain strings. The real gotcha (secrets map A2.2): pydantic-v2 `model_dump()` returns the `SecretStr` *object* for a `SecretStr`-typed field, which SQLAlchemy's JSONB encoder / the Celery JSON serializer cannot serialize — so `SmbConfig`/`S3Config` MUST carry a `field_serializer` emitting `.get_secret_value()`. **Resolved ambiguity (see returned notes):** the `field_serializer` emits the plaintext string unconditionally (`when_used="always"`); the *net* "encrypted on persist / redacted on API-out" behavior the prompt describes is produced downstream by A1's `encrypt_config_secret` (persist) and the existing `redacted()` (API-out), not by branching inside the serializer — the serializer's only job is to keep `model_dump()` JSON-serializable.

**Files:**
- Modify: `backend/app/config.py` (`printer_key`/`admin_password` → `SecretStr`; delete dead `secret_key`), `backend/app/crypto.py` (`.get_secret_value()`), `backend/app/services/bootstrap.py` (`.get_secret_value()` at the choke point), `backend/app/printers/base.py` (`access_code = field(repr=False)`), `backend/app/storage/config.py` (`SecretStr` + `field_serializer`s; fix `redacted()` truthiness)
- Modify tests: `backend/tests/test_crypto.py`, `backend/tests/test_bootstrap.py` (or wherever the generated-password log is tested), `backend/tests/test_bambu_adapter.py`/`printer_fixtures.py`, `backend/tests/test_storage_config.py`, `backend/tests/test_settings_api.py`, `backend/tests/test_migrate_task.py`

**Interfaces:** field *types* change; call-site reads that need the plaintext gain `.get_secret_value()`. No function signatures change. `SmbConfig(password="x")` / `S3Config(secret_key="x")` still accept a bare `str` (pydantic coerces `str`→`SecretStr` on a `SecretStr`-typed field), so existing fixtures keep working.

- [ ] **Step 1 — RED: `Settings` repr masking + generated-password recovery.** Add to the crypto/config test module:
  ```python
  def test_settings_repr_masks_secrets():
      s = Settings(admin_password="hunter2", printer_key="k")
      assert "hunter2" not in repr(s) and "hunter2" not in str(s)

  @pytest.mark.asyncio
  async def test_bootstrap_still_logs_the_real_generated_password(db_session, caplog):
      # admin_password unset -> a random one is generated and logged ONCE in
      # cleartext (the only recovery path). SecretStr must NOT mask THAT log.
      ...  # drive ensure_admin_user with admin_password=None; assert the logged
           # WARNING contains the actual generated password (not "**********").
  ```
  Run → RED (`Settings(admin_password=...)` currently exposes it in `repr`; and pre-change there's no masking to break, so write the assertion to fail first by temporarily leaving `admin_password: str`). Also add a `test_crypto.py` case: `load_or_create_printer_key(Settings(printer_key="<a valid Fernet key>"))` still returns usable raw bytes.

- [ ] **Step 2 — GREEN: `Settings` fields.** In `backend/app/config.py`: `from pydantic import SecretStr`; change `admin_password: str | None = None` → `admin_password: SecretStr | None = None`; `printer_key: str | None = None` → `printer_key: SecretStr | None = None`; **delete** `secret_key: str = "dev-insecure"` (confirmed dead — only self-referenced; `extra="ignore"` means a stray `TDMM_SECRET_KEY` env var is harmlessly ignored). In `backend/app/crypto.py`, `load_or_create_printer_key`: `return settings.printer_key.get_secret_value().encode()`. In `backend/app/services/bootstrap.py`, unwrap at the single choke point:
  ```python
      configured = settings.admin_password
      generated = configured is None
      password = secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES) if generated else configured.get_secret_value()
      user = User(username=settings.admin_username, password_hash=hash_password(password))
      ...
      if generated:
          logger.warning(... f"    password: {password}\n" ...)   # `password` is the plain generated str -- unchanged
  ```
  Run Step-1 tests → GREEN.

- [ ] **Step 3 — RED+GREEN: `PrinterConnection.access_code` repr.** Add:
  ```python
  def test_printer_connection_repr_hides_access_code():
      c = PrinterConnection(host="h", serial="s", access_code="12345678")
      assert "12345678" not in repr(c)
      assert c.access_code == "12345678"   # reads stay a plain str (no call-site churn)
  ```
  RED, then in `backend/app/printers/base.py` change `access_code: str` → `access_code: str = field(repr=False)` (`field` is already imported). This is the cheap, safe option the prompt confirmed (weaker than full `SecretStr` but fixes the actual latent whole-object-repr/traceback-dump leak at zero call-site cost — the two hand-written scrub functions in `bambu.py`/`printing.py` that compare `access_code` as a plain `str` are untouched). GREEN; the existing `_scrub`/probe-detail scrub tests stay green unmodified.

- [ ] **Step 4 — RED+GREEN: `SmbConfig`/`S3Config` `SecretStr` + serializer.** Add:
  ```python
  def test_smb_config_repr_masks_password_but_model_dump_is_serializable():
      import json
      c = SmbConfig(host="h", share="sh", username="u", password="hunter2")
      assert "hunter2" not in repr(c)
      dumped = c.model_dump()
      assert dumped["password"] == "hunter2"          # serializer emits plain str
      json.dumps(dumped)                               # JSONB/Celery-serializable (no SecretStr object)
  ```
  RED (today `password` is a plain `str`, so `repr` leaks; after the change `model_dump()` would return a `SecretStr` object and `json.dumps` would `TypeError` without the serializer — the test pins both halves). GREEN: in `backend/app/storage/config.py`:
  ```python
  from pydantic import BaseModel, Field, SecretStr, TypeAdapter, field_serializer

  class SmbConfig(BaseModel):
      ...
      password: SecretStr
      ...
      @field_serializer("password", when_used="always")
      def _ser_password(self, v: SecretStr) -> str:
          return v.get_secret_value()

  class S3Config(BaseModel):
      ...
      secret_key: SecretStr
      ...
      @field_serializer("secret_key", when_used="always")
      def _ser_secret_key(self, v: SecretStr) -> str:
          return v.get_secret_value()
  ```
  Fix `redacted()`'s truthiness (a `SecretStr` object is always truthy, so `if config.password` would mis-report an empty secret as set):
  ```python
  def redacted(config: StorageConfig) -> dict:
      data = config.model_dump()
      if isinstance(config, SmbConfig):
          data["password"] = "***" if config.password.get_secret_value() else ""
      if isinstance(config, S3Config):
          data["secret_key"] = "***" if config.secret_key.get_secret_value() else ""
      return data
  ```

- [ ] **Step 5 — audit the 5 `model_dump()` sites (secrets map A2.2 table).** Confirm each stays correct with the serializer emitting plain strings: `redacted()` (Step 4, fixed); `storage_config.encrypt_config_secret` (A1 — `data.get(field)` is now a plain str, `encrypt_secret` works); `set_active_config[_sync]` (go through `encrypt_config_secret`); the `PUT /storage/migrate` dispatch (A1 already wraps it in `encrypt_config_secret`, which model_dumps→plain→encrypts). No further code change — but run `test_settings_api.py` + `test_migrate_task.py` to prove the migrate/PUT paths still round-trip (a regression here throws at dispatch/commit, not at read).

- [ ] **Step 6 — full gates.** `uv run pytest` green; ruff + format clean. Grep the diff for any remaining bare `settings.printer_key`/`settings.admin_password`/`config.password`/`config.secret_key` read that needs `.get_secret_value()`.

- [ ] **Step 7 — commit.** `git add -A && git commit -m "Wrap all secret fields in SecretStr (Settings + SmbConfig/S3Config via field_serializers) and hide PrinterConnection.access_code from repr"`.

**[DEDICATED REVIEW]** (may pair with A1's reviewer) — verify: (1) no `repr`/`str`/log of `Settings`/`SmbConfig`/`S3Config`/`PrinterConnection` prints a secret; (2) the generated-admin-password log STILL emits the real cleartext (the one deliberate unmask — a regression silently breaks first-run recovery); (3) `model_dump()`→JSONB (`set_active_config`) and →Celery (`migrate` dispatch) still serialize (no `SecretStr`-object `TypeError`); (4) the M4 `_scrub`/probe-detail leak-scrub call sites (which read `access_code` as a plain `str`) are untouched and their tests green.

**Accept:** every secret field is a `SecretStr` (or `repr=False` for the dataclass); object reprs/tracebacks/logs no longer leak secrets; `model_dump()` still round-trips into JSONB and onto the Celery broker; the deliberate generated-password log still works; the dead `Settings.secret_key` is gone.

---

## Task 4: B1 — `import_from_url` re-entry idempotency (early link + orphan-detect + Redis lock) **[DEDICATED REVIEW]**

Secrets map §B1 (M5-Minor1; medium risk, touches success-path commit ordering; light dedicated pass mirroring M5 Task 3's atomicity review). Under `task_acks_late=True`, a worker SIGKILLed mid-`import_from_url` never runs its `except` cleanup; Celery redelivers the same message and the redelivered attempt reprocesses from scratch — creating a **duplicate model** and, if the crash landed after the model commit but before the `imp.model_id`/`DONE` commit, leaving the first model **orphaned** behind an import stuck `downloading`. The real fix is two-part (closes BOTH windows): (1) a per-import Redis lock (mirror `scan.py` verbatim) for concurrent redelivery, and (2) a durable orphan/terminal guard at task entry using the existing `imports.state`/`imports.model_id` columns, plus committing `imp.model_id` **early** (right after the model is created) so a crash leaves a *detectable* orphan. **No Alembic migration** — reuses existing columns.

**Files:**
- Modify: `backend/app/tasks/importing.py`
- Modify: `backend/tests/test_import_from_url.py`

**Interfaces:** `import_from_url(import_id: int) -> None` signature unchanged. New module-level `IMPORT_LOCK_TIMEOUT_S` + `import_lock_key(import_id) -> str` (mirrors `scan.SCAN_LOCK_KEY`).

- [ ] **Step 1 — RED: the direct duplicate-model regression.** In `backend/tests/test_import_from_url.py` add (mirrors the file's existing hand-built-intermediate-state pattern + the count-based atomicity assertion):
  ```python
  @pytest.mark.asyncio
  async def test_redelivery_after_partial_commit_creates_no_duplicate(fake_import, data_dir, library_root):
      from app.models.library import Model
      from app.models.system import Import
      from app.models.enums import ImportSite, ImportState
      from app.services import library
      from app.services.storage_config import resolve_backend_sync
      from app.tasks.base import sync_session
      from app.tasks.importing import import_from_url

      fake_import.files = {"cube.stl": corpus.box_stl()}
      # Fabricate the EXACT post-crash DB state: a model + revision + files
      # already committed, but imp.model_id still NULL and state still
      # DOWNLOADING (worker died between the model commit and the link commit).
      with sync_session() as s:
          imp = Import(url="https://fake.test/thing/42", site=ImportSite.THINGIVERSE,
                       external_id="42", state=ImportState.DOWNLOADING)
          s.add(imp); s.commit(); s.refresh(imp); import_id = imp.id
          backend = resolve_backend_sync(s, get_settings())
          orphan = library.create_imported_model_sync(
              s, backend, name="Fake Thing", description=None, source_url="x",
              source_site="thingiverse", source_author=None, source_license=None,
              imported_at=None, tags=[], initial_revision_name="imported")
          orphan_id = orphan.id
      # Redelivery: run the task again for the same import_id.
      import_from_url(import_id)
      with sync_session() as s:
          assert s.query(Model).count() == 1                 # the orphan was cleaned, not duplicated
          assert s.get(Model, orphan_id) is None             # stale model deleted
          imp = s.get(Import, import_id)
          assert imp.state == ImportState.DONE and imp.model_id is not None
  ```
  Run → RED: today the redelivery creates a SECOND model (`count() == 2`) and leaves `orphan_id` alive.

- [ ] **Step 2 — RED: concurrent redelivery is a no-op.** Add a lock test (mirrors the `scan.py` lock idea): hold the import lock in Redis, then call `import_from_url(id)` and assert it returns immediately without advancing the row past its current state / without a second `stream_remote_to_spool` (monkeypatch `download.stream_remote_to_spool` to record calls and assert it was NOT called while the lock is held). RED until Step 3.

- [ ] **Step 3 — GREEN: lock + entry guard + early link.** Rewrite `import_from_url` in `backend/app/tasks/importing.py`. Add near the top:
  ```python
  from redis import Redis
  IMPORT_LOCK_TIMEOUT_S = 1800
  def import_lock_key(import_id: int) -> str:
      return f"tdmm:import:{import_id}:lock"
  ```
  Wrap the body in the lock and add the entry guard; move the `imp.model_id` link to immediately after the model is created:
  ```python
  @celery_app.task(name="app.tasks.importing.import_from_url")
  def import_from_url(import_id: int) -> None:
      from app.models.library import Model, Revision
      settings = get_settings()
      client = Redis.from_url(settings.redis_url)
      lock = client.lock(import_lock_key(import_id), timeout=IMPORT_LOCK_TIMEOUT_S, blocking=False)
      if not lock.acquire(blocking=False):
          logger.info("import %s already being processed (lock held); redelivery ignored", import_id)
          return
      staged: list[download.StagedFile] = []
      created_model_id: int | None = None
      try:
          # --- entry guard: reconcile against the LAST committed state -------
          with base.sync_session() as s:
              imp = s.get(Import, import_id)
              if imp is None:
                  raise LookupError(f"import {import_id} not found")
              if imp.state in (ImportState.DONE, ImportState.FAILED):
                  return                       # redelivery of an already-terminal run: no-op
              if imp.model_id is not None:
                  # window 2: a prior attempt committed a model but died before
                  # flipping to DONE -> delete that orphan and reprocess fresh.
                  s.execute(sa_delete(Model).where(Model.id == imp.model_id))
                  imp.model_id = None
                  s.commit()
              importer = IMPORTER_REGISTRY.get(imp.site)
              if importer is None:
                  raise ImportRejected(f"no importer registered for {imp.site}")
              external_id = imp.external_id or ""
              _set_state(s, imp, ImportState.FETCHING)
          # --- (a) fetch + validate, (b) download-all (unchanged bodies) -----
          meta = importer.fetch_metadata(external_id)
          if meta.reject_reason:
              raise ImportRejected(meta.reject_reason)
          files = importer.list_files(external_id)
          if not files:
              raise ImportRejected("no downloadable files found for this model")
          with base.sync_session() as s:
              imp = s.get(Import, import_id)
              _set_state(s, imp, ImportState.DOWNLOADING)
          for f in files:
              ...  # KEEP the existing resolve_download + stream_remote_to_spool + sanitized-error block verbatim
          # --- (c) create model, LINK EARLY, then store files ----------------
          with base.sync_session() as s:
              backend = resolve_backend_sync(s, settings)
              model = library.create_imported_model_sync(s, backend, name=meta.title, ...)  # unchanged kwargs
              created_model_id = model.id
              imp = s.get(Import, import_id)
              imp.model_id = model.id        # LINK EARLY: a crash from here on leaves a DETECTABLE orphan
              s.commit()
              rev = s.get(Revision, model.current_revision_id)
              for sf in staged:
                  library.store_imported_file_sync(s, model=model, revision=rev, staged=sf)
              imp = s.get(Import, import_id)
              imp.meta = {"cover_url": meta.cover_url, "license": meta.license,
                          "files": [sf.rel_path for sf in staged]}
              _set_state(s, imp, ImportState.DONE)
      except Exception as exc:  # noqa: BLE001 -- failure is a recorded terminal state
          ...  # KEEP the existing spool-cleanup + sanitized-message + created_model_id delete + FAILED block verbatim
      finally:
          with contextlib.suppress(Exception):
              lock.release()
  ```
  (Add `import contextlib`. The existing download-error scrub, the `except` cleanup, and the `created_model_id`-delete-on-failure all stay — the early link + entry guard are additive; the entry guard handles the *redelivery* the `except` can't run for.) Run Steps 1-2 → GREEN.

- [ ] **Step 4 — regression: happy path + reject path unchanged.** Run `uv run pytest tests/test_import_from_url.py tests/test_imports_api.py tests/test_m5_import_e2e.py -q` → all green (the early link + lock don't change a clean single-attempt import; the reject-before-download path still records FAILED with no model). Full `uv run pytest` green; ruff clean.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Make import_from_url re-entry idempotent: per-import Redis lock + orphan-detect entry guard + early model_id link"`.

**[DEDICATED REVIEW]** — verify: (1) a concurrent redelivery is a clean no-op (lock); (2) a redelivery after partial phase-(c) commit deletes the orphan and produces exactly ONE model with `imp.model_id` set (window 2); (3) a redelivery after a clean DONE/FAILED is a no-op (terminal guard); (4) the early `imp.model_id` commit doesn't change the clean happy path; (5) the lock is always released (`finally`), and lock TTL (1800s) comfortably exceeds a realistic import.

**Accept:** SIGKILL-then-redeliver can no longer create a duplicate model or leave an orphan behind a stuck `downloading` import; concurrent redelivery is a no-op; the clean import + paid-reject paths are unchanged.

---

## Task 5: B2 — printerd reconciliation loop + clean per-printer thread teardown

Secrets map §B2 (low-medium risk; controller diff-skim). `printerd` queries `enabled_printers()` exactly once at startup and never again — a printer enabled/created after start is invisible until a process restart, and a disabled printer keeps a live MQTT session + command thread. The non-obvious hazard (secrets map B2.2): each printer's command thread blocks on `for msg in pubsub.listen()` with **no per-printer stop** — a naive `self._workers.pop(id)` leaks the thread and its Redis connection forever. Fix: diff `enabled_printers()` against `self._workers` every poll tick, `start_printer` newcomers, and **cleanly** tear down removed printers (unsubscribe + close the pubsub to unblock `listen()`, then join the thread).

**Files:**
- Modify: `backend/app/printerd.py`
- Modify: `backend/tests/test_printerd.py`

**Interfaces:** new `PrinterDaemon.reconcile()` and `PrinterDaemon.stop_printer(printer_id: int)`; `_subscribe_commands` now retains the `pubsub` + thread + a per-printer stop `Event` in parallel dicts (`self._pubsubs`, `self._threads`, `self._cmd_stops`).

- [ ] **Step 1 — RED: reconciliation picks up a newly-enabled printer.** In `backend/tests/test_printerd.py` (mirrors the existing `enabled_printers`-stub + real-Redis + `FakePrinterAdapter` style):
  ```python
  def test_run_reconciles_newly_enabled_printer(...):
      # start run() in a thread with enabled_printers() initially returning [];
      # after one poll tick, insert an enabled printer row; assert
      # daemon._workers gains its id within ~2 poll intervals, no restart.
      ...
  ```
  Run → RED (today `run()` only starts printers once at the top).

- [ ] **Step 2 — RED: teardown of a disabled printer exits its command thread.** Add:
  ```python
  def test_reconcile_tears_down_disabled_printer_thread(...):
      # seed two enabled printers; run() starts both -> 2 `cmd-{id}` threads;
      # disable one; after a tick assert daemon._workers drops to 1 AND the
      # corresponding threading thread named f"cmd-{id}" is no longer alive
      # (join(timeout=2.0) succeeds) -- catches the "popped the dict, leaked
      # the thread" failure mode.
      ...
  ```
  Run → RED.

- [ ] **Step 3 — GREEN: retain refs + reconcile + clean stop.** In `backend/app/printerd.py`, `PrinterDaemon.__init__` add `self._pubsubs: dict[int, redis.client.PubSub] = {}`, `self._threads: dict[int, threading.Thread] = {}`, `self._cmd_stops: dict[int, threading.Event] = {}`. Rewrite `_subscribe_commands` to retain refs and exit cleanly when the pubsub is closed:
  ```python
  def _subscribe_commands(self, printer_id: int, worker: PrinterWorker) -> None:
      pubsub = self.redis.pubsub()
      pubsub.subscribe(command_channel(printer_id))
      stop = threading.Event()

      def _loop() -> None:
          try:
              for msg in pubsub.listen():
                  if self._stop.is_set() or stop.is_set():
                      break
                  if msg["type"] != "message":
                      continue
                  try:
                      command = json.loads(msg["data"]).get("command")
                  except (ValueError, TypeError):
                      continue
                  if command:
                      try:
                          worker.handle_command(command)
                      except Exception:
                          log.exception("printerd: command %r failed", command)
          except Exception:
              # pubsub.close() from stop_printer/stop() unblocks listen() by
              # dropping the connection -> exit the thread instead of leaking it.
              pass
          finally:
              with contextlib.suppress(Exception):
                  pubsub.close()

      t = threading.Thread(target=_loop, daemon=True, name=f"cmd-{printer_id}")
      t.start()
      self._pubsubs[printer_id] = pubsub
      self._threads[printer_id] = t
      self._cmd_stops[printer_id] = stop
  ```
  Add `stop_printer` and `reconcile`, and rewrite `run()` to reconcile every tick:
  ```python
  def stop_printer(self, printer_id: int) -> None:
      stop = self._cmd_stops.pop(printer_id, None)
      if stop is not None:
          stop.set()
      pubsub = self._pubsubs.pop(printer_id, None)
      if pubsub is not None:
          with contextlib.suppress(Exception):
              pubsub.unsubscribe()
              pubsub.close()          # unblocks the listen() loop
      worker = self._workers.pop(printer_id, None)
      if worker is not None:
          with contextlib.suppress(Exception):
              worker.adapter.close()
      thread = self._threads.pop(printer_id, None)
      if thread is not None:
          thread.join(timeout=2.0)

  def reconcile(self) -> None:
      enabled = {p.id: p for p in self.enabled_printers()}
      for printer_id in list(self._workers):
          if printer_id not in enabled:
              self.stop_printer(printer_id)
      for printer_id, printer in enabled.items():
          if printer_id not in self._workers:
              try:
                  self.start_printer(printer)
              except Exception as exc:
                  log.error("printerd: failed to start printer %s: %s", printer_id, type(exc).__name__)

  def run(self) -> None:
      self.reconcile()   # initial start (replaces the old one-shot start loop)
      while not self._stop.wait(_POLL_INTERVAL_S):
          self.reconcile()
          for worker in list(self._workers.values()):
              try:
                  worker.adapter.request_full_status()
              except Exception as exc:
                  log.error("printerd: status poll failed: %s", type(exc).__name__)
  ```
  Update `stop()` to tear every worker down cleanly (so the whole-daemon stop also unblocks the command threads): `for printer_id in list(self._workers): self.stop_printer(printer_id)`. Run Steps 1-2 → GREEN.

- [ ] **Step 4 — regression + no-thread-leak sanity.** Run the full `test_printerd.py`; the existing start/poll/transition tests stay green. Add a small assertion in the teardown test that `threading.enumerate()` has no lingering `cmd-{id}` thread for the disabled printer after several enable/disable cycles. Full `uv run pytest` green; ruff clean.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add printerd reconciliation loop with clean per-printer worker/thread teardown"`.

**Accept:** a printer enabled/created after `printerd` start is supervised within ~1-2 poll ticks without a restart; a disabled printer's MQTT session AND command thread are cleanly torn down (no leaked pubsub thread/connection); the whole-daemon `stop()` also unblocks and joins the command threads.

---

## Task 6: D2 — Scan perf: batch the pass-2 N+1 + transaction checkpointing + 50k-file harness

Correctness map §D2. `run_scan` holds ONE transaction across the whole walk, and `_reconcile_unknown` does up to **~6 sync DB round-trips per unknown file** (`session.get(Blob)`, then `_resolve_adopt_target`'s `select(Model)` + `select(Revision)` + `_rel_path_taken`, then a `Blob` insert-flush + a `File` insert-flush) — **~300k round-trips for a 50k-file first scan**. Fix: bulk-preload adopt targets once before pass 2 (mirroring the existing `files_by_path` snapshot pattern), batch the `Blob`-existence lookup per chunk, `add_all` inserts per chunk, and **commit per chunk** (checkpointing — a mid-scan crash keeps prior chunks) — WITHOUT crossing the pass-1/pass-2 boundary early (the `missing_candidates` invariant). No migration.

**Files:**
- Modify: `backend/app/services/scanner.py`
- Modify: `backend/tests/test_scanner.py` (query-count harness + 50k fake-walk perf test)

**Interfaces:** `_resolve_adopt_target` / `_attach_adopted_file` / `_reconcile_unknown` gain preloaded-lookup params (`models_by_slug`, `revisions_by_key`, `taken`); a new `_preload_adopt_targets(session, deferred) -> tuple[dict, dict, set]` and a chunked `_reconcile_unknown_chunk(...)`. `run_scan` externally unchanged.

- [ ] **Step 1 — RED: query-count is bounded, not O(N).** Add a query-counting harness (SQLAlchemy `event.listen(sync_engine, "before_cursor_execute", ...)` incrementing a counter) and:
  ```python
  def test_pass2_query_count_is_bounded_regardless_of_file_count(...):
      # A fake in-memory backend.walk() yields N files ALL landing under ONE
      # pre-existing model/revision (the adopt-to-existing hot path). Run
      # scan for N=50 and N=500; assert the executed-statement count grows
      # only with chunk count (a small constant + N/_CHUNK), NOT ~6*N.
      count_50 = _scan_and_count(n=50)
      count_500 = _scan_and_count(n=500)
      assert count_500 < count_50 * 3          # sub-linear; today it is ~10x (linear)
  ```
  Run → RED (today the count scales ~6 per file → `count_500 ≈ 10 * count_50`).

- [ ] **Step 2 — GREEN: preload adopt targets.** In `backend/app/services/scanner.py`, add before pass 2:
  ```python
  def _preload_adopt_targets(
      session: Session, deferred: list[EntryInfo]
  ) -> tuple[dict[str, Model], dict[tuple[int, str], Revision], set[tuple[int, str]]]:
      """One-shot bulk load of every adopt target the pass-2 loop could need,
      replacing the per-file select(Model)/select(Revision)/_rel_path_taken
      round-trips with in-memory dict/set lookups (D2). Mirrors run_scan's
      files_by_path snapshot pattern."""
      slugs = {p[0] for e in deferred if len((p := e.key.split("/"))) >= 3}
      if not slugs:
          return {}, {}, set()
      models = list(session.execute(select(Model).where(Model.slug.in_(slugs))).scalars())
      models_by_slug = {m.slug: m for m in models}
      model_ids = [m.id for m in models]
      revisions_by_key: dict[tuple[int, str], Revision] = {}
      taken: set[tuple[int, str]] = set()
      if model_ids:
          for rev in session.execute(select(Revision).where(Revision.model_id.in_(model_ids))).scalars():
              revisions_by_key[(rev.model_id, rev.dir_name)] = rev
          rev_ids = [r.id for r in revisions_by_key.values()]
          if rev_ids:
              for rid, rel in session.execute(
                  select(File.revision_id, File.rel_path).where(File.revision_id.in_(rev_ids))
              ):
                  taken.add((rid, rel))
      return models_by_slug, revisions_by_key, taken
  ```
  Rewrite `_resolve_adopt_target` to consult these (no queries on the existing-model path; still creates+caches a draft model for a genuinely new top-level folder, and registers it into `revisions_by_key`/`taken` so later files in the same scan see it):
  ```python
  def _resolve_adopt_target(session, backend, key, draft_models, models_by_slug, revisions_by_key, taken):
      parts = key.split("/")
      if len(parts) >= 3:
          slug, dir_name, rel_path = parts[0], parts[1], "/".join(parts[2:])
          model = models_by_slug.get(slug)
          if model is not None:
              revision = revisions_by_key.get((model.id, dir_name))
              if revision is not None and (revision.id, rel_path) not in taken:
                  return model, revision, rel_path
      top = parts[0] if len(parts) > 1 else PurePosixPath(parts[0]).stem
      rel_path = "/".join(parts[1:]) if len(parts) > 1 else parts[0]
      if top in draft_models:
          model, revision = draft_models[top]
          return model, revision, rel_path
      slug = _unique_slug_sync(session, top)
      model = Model(slug=slug, name=top, review_state="adopted")
      session.add(model); session.flush()
      dir_name = layout.revision_dir_name(1, "initial")
      revision = Revision(model_id=model.id, number=1, name="initial", dir_name=dir_name)
      session.add(revision); session.flush()
      model.current_revision_id = revision.id
      layout.write_sidecar(backend, model.id, slug, top)
      draft_models[top] = (model, revision)
      models_by_slug[slug] = model
      revisions_by_key[(model.id, dir_name)] = revision
      return model, revision, rel_path
  ```
  `_attach_adopted_file` adds `taken.add((revision.id, rel_path))` after inserting the File. Thread the three preloaded structures through `_reconcile_unknown` → `_attach_adopted_file` → `_resolve_adopt_target`.

- [ ] **Step 3 — GREEN: chunked blob-lookup + inserts + checkpoint commits.** Restructure pass 2 in `run_scan` into a chunked loop:
  ```python
  models_by_slug, revisions_by_key, taken = _preload_adopt_targets(session, deferred)
  _CHUNK = 500
  for i in range(0, len(deferred), _CHUNK):
      _reconcile_unknown_chunk(session, backend, deferred[i : i + _CHUNK], missing_candidates,
                               draft_models, models_by_slug, revisions_by_key, taken,
                               adopted_index, now, counters, report)
      session.commit()   # checkpoint: a mid-scan crash keeps prior chunks (D2)
  ```
  where `_reconcile_unknown_chunk` hashes the chunk (recording per-file read errors, skipping them), does ONE `select(Blob.hash).where(Blob.hash.in_(digests))` to find existing blobs, `add_all`s the new `Blob` rows once, then per entry does the in-memory relink-or-adopt (reusing `_find_relink_candidate` + the preloaded `_attach_adopted_file`). Keep the exact reconcile *decisions* identical to today's `_reconcile_unknown` (relink a confirmed-missing same-hash row; else adopt; new-content → new blob) — only the *batching* changes. **Correctness guard:** the entire existing `test_scanner.py` decision-table suite (known-unchanged, known-changed, relink, adopt-draft, adopt-to-existing, duplicate-hash, missing, error-continues) MUST stay green unmodified. Run Step-1 test → GREEN.

- [ ] **Step 4 — RED+GREEN: checkpointing survives a mid-scan crash.** Add a test that monkeypatches `_reconcile_unknown_chunk` (or `_hash_entry`) to raise after the first chunk, then asserts the first chunk's adopted rows are queryable in a FRESH session (committed) rather than rolled back. This pins the checkpointing behavior. (The `scan_library` task still marks the run `failed` on the raised exception; the point is prior chunks' *data* survives.)

- [ ] **Step 5 — 50k-file perf harness.** Add a `_FakeWalkBackend(StorageBackend)` whose `walk("")` yields 50k synthetic `EntryInfo` (all under one pre-seeded model/revision, deterministic keys/sizes/mtimes) and whose `read()` returns tiny deterministic bytes (isolates DB cost from real disk I/O). Bulk-seed the one target model+revision via Core inserts. Assert: (a) query count is bounded (chunk-scaled), and (b) wall-clock is under a generous CI-safe bound (e.g. `< 30s` — the assertion is a regression tripwire, not a benchmark; the query-count assertion is the machine-independent signal). Run `uv run pytest tests/test_scanner.py -q` → green.

- [ ] **Step 6 — gates + commit.** Full `uv run pytest` green; ruff clean. `git add -A && git commit -m "Batch scanner pass-2 N+1 (preload adopt targets + chunked blob lookup/inserts) with per-chunk checkpoint commits"`.

**Accept:** a 50k-file first scan no longer does ~6 round-trips per unknown file (query count grows with chunk count, not file count); the scan commits in chunks so a mid-scan crash keeps prior progress; every existing reconcile-decision test stays green; the 50k harness exists and asserts the bound.

---

## Task 7: D1 — Gallery perf: keyset/filter indexes + 1k-model seed harness + <1s measurement (migration + drift-guard)

Correctness map §D1 (no N+1 exists — `list_models` is already 5 fixed queries/page; the scaling risk is missing indexes). Add the five indexes that back the keyset sorts + the `tag`/`format`/`has_sliced` filters, via ONE incremental Alembic migration (chained off head `793658394a4d`) with its drift-guard, build the missing bulk-seed harness (none exists — all test model creation is one-at-a-time today), and add a measured `< 1s` assertion for a 1k-model gallery.

**Files:**
- Modify: `backend/app/models/library.py` (add `Index`es to `Model`/`model_tags`/`Blob`/`BlobMeta`)
- Create: `backend/alembic/versions/<rev>_add_gallery_perf_indexes.py`, `backend/tests/gallery_seed.py` (bulk-seed helper), `backend/tests/test_gallery_perf.py`
- Modify: `backend/tests/test_migrations.py` (extend `EXPECTED_INDEXES`)

**Interfaces:** `gallery_seed.bulk_seed_models(session, *, count: int, tags: int = 3, with_sliced: int = 0) -> None` — direct Core `insert().values([...])` for `models`/`revisions`/`blobs`/`files`/`model_tags`, no storage/HTTP side effects.

- [ ] **Step 1 — add the indexes to the models.** In `backend/app/models/library.py`:
  - `Model.__table_args__` — append `Index("ix_models_name_id", "name", "id")` and `Index("ix_models_updated_at_id", "updated_at", "id")` (back the `sort=name` and default `-updated_at` keyset predicates).
  - After the `model_tags` `Table(...)` definition, add `Index("ix_model_tags_tag_id", model_tags.c.tag_id)` (the `tag=` filter's `model_tags.tag_id` lookup — only the composite PK exists today).
  - `Blob.__table_args__ = (Index("ix_blobs_format", "format"),)` (the `format=` filter).
  - `BlobMeta.__table_args__` — add `Index("ix_blob_meta_print_time_s", "print_time_s", postgresql_where=text("print_time_s IS NOT NULL"))` (the `has_sliced` filter; `from sqlalchemy import text`). *If `compare_metadata` false-positives on the partial predicate under the installed Alembic, drop `postgresql_where` and index the plain column — the scan-narrowing benefit is retained and the drift-guard must stay green.*

- [ ] **Step 2 — the migration.** Confirm head: `uv run alembic heads` → `793658394a4d`. Scaffold: `uv run alembic revision -m "add gallery perf indexes"` (auto-sets `down_revision="793658394a4d"`). Fill the body:
  ```python
  def upgrade() -> None:
      op.create_index("ix_models_name_id", "models", ["name", "id"])
      op.create_index("ix_models_updated_at_id", "models", ["updated_at", "id"])
      op.create_index("ix_model_tags_tag_id", "model_tags", ["tag_id"])
      op.create_index("ix_blobs_format", "blobs", ["format"])
      op.create_index("ix_blob_meta_print_time_s", "blob_meta", ["print_time_s"],
                      postgresql_where=sa.text("print_time_s IS NOT NULL"))

  def downgrade() -> None:
      op.drop_index("ix_blob_meta_print_time_s", table_name="blob_meta")
      op.drop_index("ix_blobs_format", table_name="blobs")
      op.drop_index("ix_model_tags_tag_id", table_name="model_tags")
      op.drop_index("ix_models_updated_at_id", table_name="models")
      op.drop_index("ix_models_name_id", table_name="models")
  ```

- [ ] **Step 3 — drift-guard.** Extend `backend/tests/test_migrations.py`'s `EXPECTED_INDEXES` with the five new names. Run `uv run pytest tests/test_migrations.py tests/test_migration_drift.py -q` → GREEN (`test_models_match_migrations_exactly`'s `compare_metadata` must be empty — models and migration match; `test_migration_creates_spec_indexes` sees the five new names). A RED here means the model `Index` and the migration diverge — reconcile until empty.

- [ ] **Step 4 — bulk-seed harness.** Create `backend/tests/gallery_seed.py`:
  ```python
  """Bulk-seed the gallery for perf tests via direct Core inserts -- no
  storage-backend side effects (mkdirs/sidecars) and no one-HTTP-call-per-model
  (1000 sequential POSTs would dominate the wall clock). D1: no such helper
  exists in the suite today."""
  from sqlalchemy import insert
  from sqlalchemy.orm import Session
  from app.models import Blob, File, Model, Revision, Tag
  from app.models.library import model_tags
  # ... build `count` models, each with a rev-001 + a couple of File/Blob rows,
  # `tags` shared Tag rows via model_tags, `with_sliced` of them carrying a
  # BlobMeta.print_time_s, using session.execute(insert(...).values([...])) in
  # chunks; commit once at the end.
  def bulk_seed_models(session: Session, *, count: int, tags: int = 3, with_sliced: int = 0) -> None:
      ...
  ```
  RED test for the helper itself: seed 1000, assert `session.query(Model).count() == 1000` and a subsequent `GET /api/models` returns a valid first page.

- [ ] **Step 5 — the <1s measurement.** Create `backend/tests/test_gallery_perf.py`: seed 1000 models (with tags + some sliced), then time representative gallery calls and assert each under a CI-safe bound:
  ```python
  @pytest.mark.asyncio
  async def test_1k_model_gallery_under_1s(authenticated_client, db_session):
      bulk_seed_models(db_session.sync_session_or_equivalent, count=1000, tags=5, with_sliced=100)
      for path in ["/api/models", "/api/models?q=model", "/api/models?tag=tag-1",
                   "/api/models?format=stl", "/api/models?has_sliced=true", "/api/models?sort=name"]:
          t0 = time.perf_counter()
          r = await authenticated_client.get(path)
          assert r.status_code == 200
          assert time.perf_counter() - t0 < 1.0, f"{path} took too long"
  ```
  (Seed via the sync session the harness expects; if the test uses the async `db_session`, run `bulk_seed_models` through a `sync_session()` against the same testcontainer, mirroring `test_library_provenance.py`.) Run → green (indexes make the keyset/filter paths index scans instead of full sorts/scans).

- [ ] **Step 6 — gates + commit.** Full `uv run pytest` green (existing `test_models_api.py` contract — ILIKE/escaping, tag/format/sort/cursor, cover fallback, `has_sliced`, archived-exclusion — all still green: indexes don't change results); ruff clean. `git add -A && git commit -m "Add gallery keyset/filter indexes (migration + drift-guard), a 1k-model bulk-seed harness, and a <1s gallery perf assertion"`.

**Accept:** the five indexes exist (drift-guard green, `EXPECTED_INDEXES` extended); a 1k-model gallery serves default/search/tag/format/has_sliced/name-sort queries in < 1s; the bulk-seed harness exists and the existing gallery contract is unchanged.

---

## Task 8: B3-B — Dead-letter STATE (retry ceiling + `Job.max_attempts` + auto-park) + migrate mark_done fold (migration + drift-guard)

Secrets map §B3 (controller decision: build the formal dead-letter state, not just the UI). Today `Job.attempts` has NO ceiling — a `failed` job can be retried forever and there's no data-model distinction between "worth retrying" and "will deterministically fail again." Add a `Job.max_attempts` column (default 3), a `dead` terminal state, and **auto-park** a job as `dead` when it fails at/after its ceiling. Fold the M3-deferred **migrate `mark_done`-after-cutover UX** minor here (same job-state theme; migrate.py already touched by A1). Second (and final) M6 migration — chains off D1's revision.

**Files:**
- Modify: `backend/app/models/system.py` (`Job.max_attempts`), `backend/app/services/jobs.py` (`STATE_DEAD` + auto-park in `mark_failed` + retry accepts `dead`), `backend/app/tasks/migrate.py` (mark_done fold)
- Create: `backend/alembic/versions/<rev>_add_job_max_attempts.py`
- Modify: `backend/app/schemas/jobs.py` (expose `max_attempts` on `JobOut`), `backend/tests/test_jobs_api.py`, `backend/tests/test_migrate_task.py`

**Interfaces:** `Job.max_attempts: Mapped[int]` (server_default "3"); `jobs.STATE_DEAD = "dead"`; `JobOut` gains `attempts: int` (if not already) + `max_attempts: int` for the frontend (Task 9) to compute "dead-lettered".

- [ ] **Step 1 — RED: auto-park on ceiling.** In `backend/tests/test_jobs_api.py` (mirrors the file's hand-built-job pattern):
  ```python
  def test_job_failing_at_retry_ceiling_is_parked_dead(db_session_sync, ...):
      # seed a Job with attempts=3, max_attempts=3, state=running; call
      # jobs.mark_failed(session, str(job.id), "boom"); assert state == "dead".
      ...
  def test_job_failing_below_ceiling_stays_failed(...):
      # attempts=1, max_attempts=3 -> mark_failed leaves state == "failed".
      ...
  ```
  Run → RED (`Job` has no `max_attempts`; `mark_failed` always sets `failed`).

- [ ] **Step 2 — GREEN: column + migration + drift-guard.** In `backend/app/models/system.py` add to `Job`: `max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="3")`. Confirm head `uv run alembic heads` → the D1 revision; scaffold `uv run alembic revision -m "add job max_attempts"`; body:
  ```python
  def upgrade() -> None:
      op.add_column("jobs", sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"))
  def downgrade() -> None:
      op.drop_column("jobs", "max_attempts")
  ```
  Run `uv run pytest tests/test_migration_drift.py -q` → GREEN (`compare_metadata` empty; no `EXPECTED_INDEXES` change — it's a column).

- [ ] **Step 3 — GREEN: auto-park + retry semantics.** In `backend/app/services/jobs.py`: add `STATE_DEAD = "dead"`. Rewrite `mark_failed`:
  ```python
  def mark_failed(session: SyncSession, job_id: str, error: str) -> None:
      job = _load_job(session, job_id)
      job.state = STATE_DEAD if job.attempts >= job.max_attempts else STATE_FAILED
      job.error = error
      session.commit()
      _publish(job)
  ```
  (attempts is incremented once per top-level run in `mark_running`, so a job that has run `max_attempts` times and fails the last is parked `dead`.) In `retry_job`, allow a manual retry of a `dead` job as the operator escape hatch (auto-retry stops at `dead`, manual override doesn't): change the guard from `job.state != STATE_FAILED` to `job.state not in (STATE_FAILED, STATE_DEAD)`. Run Step-1 tests → GREEN.

- [ ] **Step 4 — expose on `JobOut`.** In `backend/app/schemas/jobs.py`, ensure `JobOut` includes `attempts: int` and `max_attempts: int` (add to `from_model`). Frontend (Task 9) renders "dead-lettered" from `state == "dead"` (or `attempts >= max_attempts`). Add/extend a `test_jobs_api.py` assertion that `GET /api/jobs` surfaces these fields.

- [ ] **Step 5 — GREEN: migrate mark_done fold (M3 minor).** In `backend/app/tasks/migrate.py`, restructure so a bookkeeping failure AFTER a successful cutover doesn't reflip the job to `failed` (the migration genuinely succeeded — config already switched, source intact):
  ```python
      try:
          for entry in source.walk(""):
              ...  # verify each file (unchanged)
          with base.sync_session() as s:
              set_active_config_sync(s, settings, target_cfg)   # cutover -- point of no return
      except Exception as exc:
          with base.sync_session() as s:
              jobs.mark_failed(s, job_id, str(exc))
          raise
      # Cutover succeeded: mark done in its OWN try so a post-cutover publish/
      # commit hiccup can't misreport a done migration as failed (M3 minor).
      try:
          with base.sync_session() as s:
              jobs.mark_done(s, job_id)
      except Exception:
          logger.warning("migrate %s: cutover succeeded but marking done failed", job_id, exc_info=True)
  ```
  (Add a module `logger`.) Extend `test_migrate_task.py` with a case that patches `mark_done` to raise once and asserts the storage config is STILL switched (cutover stuck) and the task doesn't mark the job `failed`.

- [ ] **Step 6 — gates + commit.** Full `uv run pytest` green; ruff clean. `git add -A && git commit -m "Add formal dead-letter job state (max_attempts ceiling + auto-park) and stop migrate misreporting a done cutover as failed"`.

**Accept:** a job that fails at/after `max_attempts` is parked `dead` (distinct from a first `failed`); `POST /jobs/{id}/retry` still works as a manual override for `failed` AND `dead`; `JobOut` exposes `attempts`/`max_attempts`; a successful storage migration is never reported `failed` due to a post-cutover bookkeeping hiccup; migration + drift-guard green.

---

## Task 9: B3-A — Build the Jobs page (replace the `/jobs` ComingSoon stub) + list/retry hooks

Secrets map §B3.1/§B3.5. `/jobs` renders `<ComingSoonPage title="Jobs" />` today — B3's frontend is greenfield. `web/src/api/jobs.ts` only has a single-job poller (`useJob`); there is no `useJobs()` list hook, no retry mutation. Backend is already complete (`GET /api/jobs`, `POST /api/jobs/{id}/retry`, and Task 8's dead-letter state) — this task is pure frontend, reusing those endpoints verbatim.

**Files:**
- Modify: `web/src/api/jobs.ts` (add `useJobs` + `useRetryJob`), `web/src/api/types.ts` (`Job` type + `dead` in state union), `web/src/routes.tsx` (swap the route), `web/src/pages/useEvents.tsx` (invalidate `["jobs"]` on `job.updated`)
- Create: `web/src/pages/JobsPage.tsx`, `web/src/pages/JobsPage.test.tsx`

- [ ] **Step 1 — hooks.** In `web/src/api/jobs.ts`, add alongside `useJob` (follow the `usePrintJobs`/`api/printers.ts` hook shape):
  ```ts
  export function useJobs(params: { state?: string } = {}) {
    return useQuery({
      queryKey: ["jobs", "list", params],
      queryFn: () => api.get<Job[]>(`/api/jobs${params.state ? `?state=${params.state}` : ""}`),
    });
  }
  export function useRetryJob() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => api.post(`/api/jobs/${id}/retry`, {}),
      onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
    });
  }
  ```
  RED: a hook test asserting `useJobs({state:"failed"})` calls `GET /api/jobs?state=failed` and `useRetryJob` invalidates `["jobs"]` on success (mirror the existing TanStack mutation-invalidation test patterns in the printer/scan hook test files).

- [ ] **Step 2 — the page.** Create `web/src/pages/JobsPage.tsx` — a table mirroring `PrintJobHistory.tsx`'s conventions (Badge per `state`, truncated `error` cell with a `title` tooltip for the full message, `Skeleton` while loading, empty-state copy). Features: a state-filter dropdown (`?state=` — supports `failed`/`dead`/`done`/`running`/`queued`) defaulting to surfacing **failed + dead prominently** (the dead-letter ask); a per-row **Retry** button for `failed`/`dead` rows wired to `useRetryJob`, **hidden/disabled for `job.type === "migrate_storage"`** (backend hard-409s it — avoid a dead button); the 409 "subject/spool no longer exists" cases surfaced as an inline `error.detail` message (mirror `PrintJobHistory.tsx`'s `ApiError`-detail rendering); a distinct **"dead-lettered"** badge/style when `state === "dead"` (or `attempts >= max_attempts`).

- [ ] **Step 3 — wire route + live refresh.** In `web/src/routes.tsx`, replace `component: () => <ComingSoonPage title="Jobs" />` with `component: JobsPage` (+ `import { JobsPage } from "@/pages/JobsPage"`). In `web/src/pages/useEvents.tsx`, ensure the `job.updated` handler invalidates `["jobs"]` (so the Jobs page live-updates as tasks transition) — add it to the existing branch if not present.

- [ ] **Step 4 — page test.** Create `web/src/pages/JobsPage.test.tsx` (mirror existing page-test setup): render with a mocked `failed` job, click Retry, assert the mutation fires with the right id + a re-render; render a `migrate_storage`-typed failed job and assert NO (or disabled) Retry control; render a `dead` job and assert the dead-lettered badge shows.

- [ ] **Step 5 — gates + commit.** `npm run build` (tsc strict) green, `npm run lint` clean, `npm test` green. `git add -A && git commit -m "Build the Jobs page (list + state filter + retry + dead-letter surfacing) replacing the ComingSoon stub"`.

**Accept:** `/jobs` is a real page listing jobs with a state filter, surfacing failed + dead-lettered jobs, a working per-row Retry (hidden for `migrate_storage`, 409 detail surfaced inline), and a dead-lettered badge; the list live-updates via the `job.updated` SSE branch.

---

## Task 10: B4 — "Add files" on the model detail page → current revision via `PUT /api/uploads`

Correctness map §B4. Add an "Add files" action on the model detail page that uploads into the model's **current revision** through the existing `PUT /api/uploads` seam (`model_id` + `current_revision.id`, both already on the `ModelDetail` fetch), reusing the upload-queue components. NOT auto-new-revision (`create_revision` is a costly full snapshot-copy that 409s mid-upload — the controller-confirmed decision). No backend endpoint/migration needed.

**Files:**
- Create: `web/src/components/upload/UploadDropzone.tsx` (extracted from `UploadPage.tsx`), `web/src/components/upload/UploadDropzone.test.tsx`
- Modify: `web/src/pages/UploadPage.tsx` (consume the extraction), `web/src/components/model-detail/FilesTab.tsx` (Add-files action), `backend/tests/test_uploads_api.py` (regression lock)

- [ ] **Step 1 — extract the reusable upload unit.** Factor the drag/drop JSX + queue state/handlers (`addFiles`/`updateItem`/`removeItem`/`handleStartUpload`) out of `UploadPage.tsx` into `UploadDropzone` (or a `useUploadQueue` hook + a thin dropzone), reusing `web/src/lib/droppedFiles.ts` (`resolveDroppedFiles`) and `web/src/components/upload/UploadQueueItem.tsx` (both already generic). Parametrize the target (`{ modelId, revisionId }`) and the on-complete invalidation callback. RED: render the extracted component with a mocked `uploadFile` (`vi.mock("@/api/upload")`), simulate a file select/drop, assert `uploadFile` called with the expected `relPath` and a queue row transitioning `pending → uploading` via `UploadQueueItem`. Keep `UploadPage.tsx` behavior identical (its own tests stay green).

- [ ] **Step 2 — Add-files on `FilesTab`.** In `web/src/components/model-detail/FilesTab.tsx`, add an "Add files" button (or hidden `<input type="file" multiple>` + Browse for v1) that mounts `UploadDropzone` targeted at `{ modelId: model.id, revisionId: model.current_revision.id }` (guard on `model.current_revision` truthiness the same way `UploadPage.tsx` does), and on batch completion invalidates `modelQueryOptions(model.slug).queryKey` — NOT the gallery-only `["models"]` key (correctness map §6: the open detail page would otherwise stay stale). No model search, no `create_revision` call. RED: render `FilesTab` with a zero-file model, click Add files, select a fake `File`, assert `uploadFileMock` called with `{ modelId: model.id, revisionId: model.current_revision.id, relPath: file.name, file }` and that NO model-search/target-resolution step occurs.

- [ ] **Step 3 — backend regression lock (no code change expected).** In `backend/tests/test_uploads_api.py`, add a test mirroring `test_upload_to_non_current_revision_is_409` but with a FRESH (non-colliding) `rel_path`, isolating the staleness-409 branch from the name-collision-409 branch — proves the new frontend seam still can't smuggle an upload onto a stale revision if a future refactor caches a `revisionId` across a revision bump. Assert `validate_upload_target` 409s ("uploads are only allowed on the model's current revision"). Run → green (no backend change; this locks the contract the frontend relies on).

- [ ] **Step 4 — gates + commit.** `npm run build`/`lint`/`test` green; backend `uv run pytest tests/test_uploads_api.py -q` green. `git add -A && git commit -m "Add 'Add files' to the model detail page (uploads into the current revision via PUT /api/uploads)"`.

**Accept:** the model detail page has an "Add files" action that uploads into the current revision (reusing the upload-queue components), refreshes the open detail page (not just the gallery), makes no `create_revision` call, and the backend still 409s any stale-revision upload.

---

## Task 11: Folded UX minors — review_state gallery badge + dismiss; `usePrinterStatus` stop-poll on terminal

Ledger folds (M3 review_state gallery exposure; M4 minor #3). Two small, independent UX folds.

**Files:**
- Modify: `backend/app/schemas/library.py` (`ModelSummary.review_state`, `ModelDetail.review_state`), `backend/app/services/library.py` (populate both), `backend/tests/test_models_api.py`
- Modify: `web/src/api/types.ts` (`review_state`), `web/src/components/gallery/ModelCard.tsx` (badge + dismiss), `web/src/api/printers.ts` (`usePrinterStatus` stop-poll), + their tests

- [ ] **Step 1 — RED+GREEN: expose review_state.** Add `review_state: str | None = None` to `ModelSummary` and `ModelDetail`. In `list_models`, add `review_state=m.review_state` to the `ModelSummary(...)` construction; in the detail builder, set it on `ModelDetail`. Extend `test_models_api.py` to assert an adopted model (seed `review_state="adopted"`) surfaces `review_state == "adopted"` in both the gallery list and the detail, and a normal model shows `null`.

- [ ] **Step 2 — gallery badge + dismiss.** In `web/src/api/types.ts`, add `review_state?: string | null` to `ModelSummary`/`ModelDetail`. In `ModelCard.tsx`, render a small **"Needs review"** badge when `model.review_state === "adopted"`, with a dismiss control that calls the existing model-PATCH (`patch_model` already allows clearing `review_state` — send `review_state: null`), invalidating `["models"]` on success. RED: a component test asserting the badge shows for an adopted model, is absent otherwise, and that dismiss fires the PATCH with `review_state: null`.

- [ ] **Step 3 — `usePrinterStatus` stop-poll on terminal.** In `web/src/api/printers.ts`, make `usePrinterStatus`'s `refetchInterval` return `false` (stop polling) when the latest `gcode_state` is terminal (`FINISH`/`FAILED`/`IDLE` per the M4 status contract) — mirrors the M4 backlog minor. RED: a hook test asserting `refetchInterval` is a positive number while `RUNNING` and `false` once `gcode_state` is terminal.

- [ ] **Step 4 — gates + commit.** Backend `uv run pytest tests/test_models_api.py -q` green + full suite green + ruff clean; web `build`/`lint`/`test` green. `git add -A && git commit -m "Expose review_state with a gallery 'needs review' badge + dismiss, and stop printer-status polling on a terminal state"`.

**Accept:** an adopted (scanner-drafted) model shows a dismissable "Needs review" badge on its gallery card, backed by `review_state` now on `ModelSummary`/`ModelDetail`; `usePrinterStatus` stops polling once a print reaches a terminal state.

---

## Task 12: Test hygiene — C2 paho warning filter + C3a-d

Correctness map §C2/§C3. Five small, low-risk hygiene folds that keep the gate output pristine and close coverage/behavior gaps. Controller diff-skim.

**Files:**
- Modify: `backend/pyproject.toml` (C2 filterwarnings), `backend/tests/test_storage_registry.py` (C3a), `backend/tests/test_bambu_adapter.py` (C3b), `backend/tests/test_thingiverse_importer.py` (C3c), `backend/app/services/import_tokens.py` + `backend/tests/test_import_tokens_api.py` (C3d)

- [ ] **Step 1 — C2: filter the vendored paho `ssl.PROTOCOL_TLS` warning.** In `backend/pyproject.toml`'s `[tool.pytest.ini_options] filterwarnings` list (the sole existing entry is the testcontainers one), add — matching that entry's exact shape (message-prefix + category):
  ```toml
  "ignore:ssl.PROTOCOL_TLS is deprecated:DeprecationWarning",
  ```
  Verify: `uv run pytest tests/test_bambu_adapter.py -q` — the warnings summary is now empty (the one warning from `test_test_connection_bounded_against_unreachable_host` is gone). This is itself a quality-gate assertion (pristine output), no new behavior test needed.

- [ ] **Step 2 — C3a: registry smb/s3 factory-path test.** In `backend/tests/test_storage_registry.py`, add (both constructors are I/O-free, so this stays fast/deterministic):
  ```python
  def test_get_backend_returns_smb_backend_for_smb_config():
      from app.storage.smb import SmbStorageBackend
      cfg = SmbConfig(host="h", share="sh", username="u", password="p")
      assert isinstance(get_backend(get_settings(), cfg), SmbStorageBackend)

  def test_get_backend_returns_s3_backend_for_s3_config():
      from app.storage.s3 import S3StorageBackend
      cfg = S3Config(bucket="b", access_key="a", secret_key="s")
      assert isinstance(get_backend(get_settings(), cfg), S3StorageBackend)
  ```
  Closes the M3-carried gap: `_build_smb_backend`/`_build_s3` factory paths were never executed by any test.

- [ ] **Step 3 — C3b: UNKNOWN-guard + `_dump_get` nested-fallback stub tests.** In `backend/tests/test_bambu_adapter.py`, add two fast deterministic tests (mirror the M4 backlog minor #4):
  ```python
  def test_dump_get_reads_nested_print_dict():
      from app.printers import bambu
      assert bambu._dump_get({"print": {"gcode_state": "RUNNING"}}, "gcode_state") == "RUNNING"

  def test_test_connection_skips_unknown_state_then_succeeds(monkeypatch):
      # StubPrinter.get_state() sequence ["UNKNOWN", "RUNNING"]; patch
      # bambu.time.sleep -> no-op so the poll loop is instant; assert the
      # probe returns ok=True with gcode_state "RUNNING" (the UNKNOWN branch
      # is exercised deterministically in ms, not via a >1s real socket).
      monkeypatch.setattr(bambu.time, "sleep", lambda _s: None)
      ...
  ```

- [ ] **Step 4 — C3c: Thingiverse contract test's real-empty-session leak.** In `backend/tests/test_thingiverse_importer.py`, add a local no-op override of the suite-wide autouse `_truncate_all_tables` fixture (pytest requires re-declaring `autouse=True` on the override; the four offline tests — `test_canonicalize`/`test_fetch_metadata_normalizes`/`test_list_files_from_zip_data`/`test_resolve_download_adds_bearer` — do pure HTTP-mock/string parsing and never touch the DB):
  ```python
  @pytest.fixture(autouse=True)
  def _truncate_all_tables():
      yield  # these tests are DB-free; skip the suite-wide TRUNCATE/migrated_db cost
  ```
  Verify via `uv run pytest tests/test_thingiverse_importer.py::test_canonicalize --setup-show` that it no longer resolves `migrated_db`/`postgres_url`.

- [ ] **Step 5 — C3d: blank import-token PUT must not write a null `Setting` row.** In `backend/app/services/import_tokens.py`, short-circuit `set_thingiverse_token` to a true no-op when clearing a non-existent row:
  ```python
  async def set_thingiverse_token(db, settings: Settings, token: str | None) -> None:
      row = await db.get(Setting, SETTINGS_KEY)
      if token is None and row is None:
          return  # nothing stored + nothing to store: don't create a null row
      stored = encrypt_secret(settings, token) if token else None
      value = {"thingiverse_token": stored}
      if row is None:
          db.add(Setting(key=SETTINGS_KEY, value=value))
      else:
          row.value = value
      await db.commit()
  ```
  RED test in `backend/tests/test_import_tokens_api.py`: `test_blank_put_with_nothing_stored_creates_no_setting_row` — `PUT /import-tokens {"thingiverse_token": ""}` on a fresh DB, assert `await db_session.get(Setting, "import_tokens") is None` (fails today — a null row gets created).

- [ ] **Step 6 — gates + commit.** Full `uv run pytest` green with PRISTINE output (the paho warning gone); ruff clean. `git add -A && git commit -m "Test hygiene: filter paho TLS warning; registry smb/s3 factory test; UNKNOWN-guard/_dump_get stubs; TV contract no-DB override; no null import-token row"`.

**Accept:** the default gate output is pristine (no paho `DeprecationWarning`); the smb/s3 registry factory paths, the `_dump_get` nested branch, and the UNKNOWN-state poll branch all have fast deterministic coverage; the Thingiverse offline tests no longer spin up the DB; a blank import-token PUT with nothing stored writes no row.

---

## Task 13: C1 — Backup & Restore documentation (docs-only)

Correctness map §C1. A README/docs "Backup & Restore" section — no such doc exists today. Docs-only: no code, no RED tests. Acceptance is the outline below + one **manual restore drill** against a scratch stack (the spec's "full restore drill from backup" accept criterion, a deferred/manual step like M4's live acceptance — note it, don't automate it).

**Files:**
- Modify: `README.md` (new "Backup & Restore" section)

- [ ] **Step 1 — write the section.** Add to `README.md` (cite SPEC M6 "backup/restore doc"), covering exactly:
  - **What to back up:** (1) **Postgres** — `docker compose exec db pg_dump -U tdmm tdmm > backup.sql` (no host port is published; go through `compose exec`). Holds models/revisions/files/jobs/settings (storage config + **encrypted** import token) / printers (`access_code_enc`). (2) **`{TDMM_DATA_DIR}/secrets/printer.key`** (or the matching `TDMM_PRINTER_KEY` value) — **CRITICAL:** this ONE Fernet key now decrypts printer access codes AND (M6) the SMB/S3 storage secrets AND the Thingiverse token; **losing it or restoring a DB against a different key makes every encrypted secret permanently undecryptable** (`InvalidToken`) while everything else restores fine. The DB backup and the key MUST be restored together and stay in sync. (3) **`library/`** content — the bind-mount (local backend) OR the operator's own SMB share / S3 bucket (out of this app's control for non-local backends). Branch the instructions on the active storage backend.
  - **What NOT to back up:** `{TDMM_DATA_DIR}/derivatives/**` (regenerable — re-run the pipeline against library originals; `migrate.py` documents "DERIVATIVES ALWAYS STAY LOCAL"); `{TDMM_DATA_DIR}/spool/**` (transient in-flight upload bytes).
  - **Restore runbook:** fresh `db` service + `docker compose exec -T db psql -U tdmm tdmm < backup.sql`; restore `printer.key` into the `tdmm_data` volume (or set matching `TDMM_PRINTER_KEY`) BEFORE starting api/worker/printerd; restore `library/`; start the stack (Alembic runs automatically on api boot; the M6 eager re-encryption pass is idempotent and safe on an already-encrypted restore).
  - **Loud warning:** `docker compose down --volumes` destroys BOTH `pgdata` AND `tdmm_data` (DB + derivatives + **secrets** + spool) together, irrecoverably — same tone as the existing admin-password-not-recoverable callout (README.md:43-53). Cross-reference the existing "Printer integration → Security" key section (README.md:139-149) rather than duplicating it.
  - **Reference env vars that must match across a restore:** `TDMM_DATABASE_URL`, `TDMM_DATA_DIR`, and the `db` service's `POSTGRES_USER`/`PASSWORD`/`DB`.

- [ ] **Step 2 — manual acceptance note.** Add a clearly-labeled "verified via a one-time manual restore drill" note (mirroring M4's deferred live-acceptance style): the drill = `pg_dump` a seeded stack, `down --volumes`, restore DB + `printer.key` + library into a fresh stack, confirm the gallery + a printer's decrypted access code + a stored storage secret all survive. Flag it as a manual/deferred step (not a unit test).

- [ ] **Step 3 — commit.** `git add -A && git commit -m "Document Backup & Restore (pg_dump + the Fernet key criticality + regenerable derivatives + plain-file library)"`.

**Accept:** README has a Backup & Restore section covering what to back up (DB + the one Fernet key + library), what not to (derivatives/spool), the restore runbook, the down --volumes warning, and the key-must-travel-with-the-DB criticality; a manual restore drill is noted as the deferred acceptance step.

---

## Self-Review

**1. Coverage vs. both surface maps + the confirmed decisions.** Every in-scope item maps to a task (see the Backlog Triage Table); every confirmed controller decision is encoded exactly:
- **U1** (Task 1) fixes the shared `meshload` loader (both trimesh + lib3mf branches), correcting BOTH `BlobMeta` dims/volume/area AND the GLB derivative scale, with the real `DotC parts - Part 2.3mf` (`unit="meter"`) regression asserting `≈ [6.45, 6.45, 2.8]` and explicit STL/OBJ/mm-3MF unaffected guards — exactly the decision.
- **A1** (Task 2) mirrors the M4 Fernet pattern at the centralized `storage_config`/`import_tokens` seams, encrypts SMB/S3 secrets AND the Thingiverse token, does **EAGER** startup re-encryption of legacy plaintext (not lazy), keeps API responses redacted, encrypts the migrate Celery target, and shares the key under `{data_dir}/secrets`. **[DEDICATED REVIEW]**.
- **A2** (Task 3) wraps ALL secret fields in `SecretStr` including `SmbConfig`/`S3Config` via `field_serializer`s (so `model_dump()`→JSONB/Celery survives — the A2.2 hazard is closed at all 5 sites), and `repr=False` on `PrinterConnection.access_code`. **[DEDICATED REVIEW]**.
- **B1** (Task 4) builds the REAL fix: early `imp.model_id` link + orphan-detection entry guard + per-import Redis lock, `acks_late`-safe, closing BOTH redelivery windows. **[DEDICATED REVIEW]**.
- **B2** (Task 5) adds periodic `enabled_printers()` reconciliation AND the clean per-printer thread stop (pubsub unsubscribe+close to unblock `listen()`, then join) — the leaked-thread hazard is tested.
- **B3 A+B** split across Task 8 (dead-letter STATE: `Job.max_attempts` + `dead` + auto-park + migration + drift-guard) and Task 9 (the Jobs page replacing ComingSoon + list/retry hooks + SSE live-refresh).
- **B4** (Task 10) adds "Add files" → current revision via `PUT /api/uploads` (NOT auto-new-revision), reusing the extracted upload-queue components; backend regression-locks the stale-revision 409.
- **D1** (Task 7) adds the five missing indexes via migration + drift-guard, the 1k bulk-seed harness, and the `<1s` assertion.
- **D2** (Task 6) batches the pass-2 N+1 (preload adopt targets + chunked blob lookup/inserts) + per-chunk checkpoint commits + a 50k fake-walk harness with a query-count-bounded assertion.
- **C1** (Task 13) docs; **C2/C3a-d** (Task 12) hygiene; folded minors (Task 11 review_state badge+dismiss + usePrinterStatus stop-poll; Task 8 migrate mark_done UX).
- Two migrations (D1 Task 7 off head `793658394a4d`; B3a Task 8 off D1's revision), each with its drift-guard obligation spelled out (compare_metadata green + `EXPECTED_INDEXES` extended for D1). Deferred items each carry a technical reason in the triage table (TOFU pin → needs live cert; STL-Web-Worker/`bambustudio://`/IGES-flag → features not hardening; M3/M5 residual minors → documented non-issues / correctness-neutral).

**2. Placeholder scan.** No "add validation"/"similar to Task N"/"TBD" — every logic step carries real code (the encrypt/decrypt seam, the entry guard + early link, the reconcile/teardown, the preload + chunk loop, the index `create_index` bodies, the `mark_failed` auto-park, the `set_thingiverse_token` short-circuit) and every test step names concrete assertions (exact mm extents, ciphertext-not-plaintext at rest, `count() == 1` + orphan-deleted, thread-not-alive after teardown, sub-linear query count, `< 1s`, `state == "dead"`, `Setting is None`). Frontend steps give real hook code + concrete component conventions to mirror (`PrintJobHistory.tsx`) rather than vague "build a page." The few places that say "mirror the existing X pattern/verbatim body" point at a NAMED existing function whose exact code this plan already quoted (e.g. keep the download-error scrub / `except` cleanup verbatim in B1) — a deliberate "don't rewrite the reviewed code," not a placeholder.

**3. Type/interface consistency.** The signature changes cascade coherently: `get_active_config[_sync]`/`set_active_config[_sync]` gain `settings` (Task 2) → every caller updated (`api/settings.py` GET/PUT/test/migrate + `_merge_stored_secrets`, `migrate.py` cutover, `resolve_backend[_sync]` pass-through, and the direct-calling tests); `import_tokens` accessors gain `settings` → `api/settings.py` + `test_import_tokens_api.py`. `SECRET_FIELD_BY_BACKEND` is single-owned in `storage/config.py` and imported by `api/settings.py` + `storage_config.py` + `secrets_at_rest.py`. A2's `field_serializer` keeps `encrypt_config_secret`/`redacted`/`set_active_config`/migrate-dispatch model_dumps emitting `str`, matching what A1 consumes. B1's `import_lock_key`/entry-guard reuse existing `imports.state`/`imports.model_id` columns (no schema change). Task 8's `Job.max_attempts` + `STATE_DEAD` flow through `mark_failed` → `JobOut` → the Task 9 Jobs page. D1's model `Index`es match the migration `create_index` names exactly (compare_metadata guard) and the `EXPECTED_INDEXES` set. Task 11's `ModelSummary.review_state`/`ModelDetail.review_state` (backend) mirror `web/src/api/types.ts` and feed `ModelCard`'s badge/dismiss (which reuses the existing model-PATCH clear).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-m6-hardening.md`. 13 tasks; 3 flagged [DEDICATED REVIEW] (Task 2 A1, Task 3 A2, Task 4 B1). Two Alembic migrations (Task 7 D1, Task 8 B3a), each with its drift-guard obligation.**

**Recommended execution — Subagent-Driven (per the ledger's reduced-review policy):** dispatch a fresh implementer subagent per task (instruct it NOT to spawn its own reviewers), controller diff-skims between tasks, with a **DEDICATED reviewer on Tasks 2, 3, 4 only**, then ONE whole-branch review + ONE fix wave at milestone close. Weight the whole-branch review on: the at-rest encryption round-trip + redaction (Tasks 2/3), the import re-entry idempotency ordering (Task 4), and the two migrations' drift-guards (Tasks 7/8). Suggested ordering is the task numbering (contracts/secrets/reliability first; migrations chained D1→B3a; frontend + hygiene + docs last), but Tasks 1, 5, 6, 10, 11, 12, 13 are independent and can be parallelized across worktrees if desired.
