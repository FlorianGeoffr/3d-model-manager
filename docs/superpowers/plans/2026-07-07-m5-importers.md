# M5 Implementation Plan — Gallery importers (Thingiverse + Printables)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a Thingiverse or Printables model URL on `/import`; the app auto-detects the site, fetches metadata (title/author/license/tags/cover), streams **every** downloadable file straight to the upload spool (blake3-hashing each), and — only once all files are staged — creates the library `Model` + `rev-001_imported` revision (with provenance) and injects each staged file into the **same ingest pipeline a browser upload uses** (`finalize` → `store_to_backend` → glb/thumbs). A paid/Club/exclusive model is rejected with a clear message **before any byte is downloaded**; a failed import leaves **zero** orphan `Model`/`Revision` rows (`imports.model_id` NULL). Import progress rides the existing `job.updated` SSE channel; a dedicated `GET /api/imports/{id}` is the primary poll path. Provenance (source site link, author, license) is shown on the model page and a source badge on the gallery card. The Thingiverse app token is stored plaintext-masked in Settings (never returned in a GET, never logged).

**Deferred to a later milestone: MakerWorld.** M5 ships **Thingiverse + Printables only**. The `ImportSite.MAKERWORLD` enum already exists and is left untouched; the architecture stays MakerWorld-ready (the registry is keyed by `ImportSite`). A pasted **MakerWorld URL never crashes** — the `/import` UI detects it client-side and shows a friendly "MakerWorld import isn't available yet" message, and the backend returns a clear `422` for it. No `TDMM_MAKERWORLD_ENABLED` flag, no `crypto.py` generalization, and no Bambu-account login are in M5 scope.

**Architecture:** A `SiteImporter` **Protocol** (`app/importers/base.py`) with three frozen dataclasses (`ImportMetadata`, `ImportFile`, `ResolvedDownload`) is the only thing the orchestration task speaks. A registry keyed by `ImportSite` (`app/importers/registry.py`, `build_importer_for_url(url) -> SiteImporter | None`) auto-detects the site from a pasted URL via each importer's `canonicalize(url)` (returns the site's external id, or `None`). Two concrete importers register instances: `ThingiverseImporter` (official REST `GET /things/{id}`, `zip_data.files[]/images[]`, `Authorization: Bearer <app token>`) and `PrintablesImporter` (unofficial GraphQL `print(id:)` + `getDownloadLink`, anonymous with a browser-like UA, Club/paid rejected). An in-memory `FakeImporter` (`app/importers/fake.py`) drives every orchestration test before any real-site code exists. The `import_from_url` **Celery task** (`app/tasks/importing.py`) runs in the worker's **sync** world (`app.tasks.base.sync_session()` — the same async/API-vs-sync/worker split M1–M4 established): it marks the `Import` row `fetching`, calls `fetch_metadata` + `list_files`, validates (rejecting paid/Club/exclusive), marks `downloading`, streams **all** files to spool via `app.importers.download.stream_remote_to_spool`, then — atomically — creates the model+revision and dispatches each staged file through `library.store_imported_file_sync` (which packages `finalize` + `create_job` + `store_to_backend.apply_async`, exactly the `PUT /uploads` seam). The API layer (`app/api/imports.py`) is thin: `POST /imports` (detect + create pending row + dispatch), `GET /imports/{id}` (poll the row), `GET /imports` (list). Frontend: a real `ImportPage`, `web/src/api/imports.ts` hooks, a `SiteTokensCard` in Settings, a `job_type === "import_from_url"` branch in `useEvents.tsx`, a provenance block on the model page, and a source badge on the gallery card.

**Tech Stack:** `httpx` **promoted from the dev group to a runtime `[project]` dependency** (bare name — the only outbound HTTP client the app now needs, sync `Client` for the worker's importer/download calls) · the existing generic `jobs`/SSE/`store_to_backend`/pipeline machinery (an import file is just another `store_to_backend` job) · the existing `settings` `Setting`-row pattern for the token · recorded hand-built JSON cassettes served through **`httpx.MockTransport`** (built into httpx — **no new test dependency**) as the ONLY mocked edge · React + TanStack Router/Query + shadcn (existing web stack) · real Postgres + Redis testcontainers + real Alembic migration (unchanged hard rule) · one marked-and-excluded `@pytest.mark.live_importer` smoke test per importer (the deferred/manual live analog of M4's live-A1 acceptance).

Executes milestone **M5** of `docs/superpowers/specs/2026-07-04-3d-model-manager-design.md` (SPEC) and its fuller companion `docs/superpowers/specs/2026-07-04-3d-model-manager-design-full.md` (FULL). Read SPEC "Gallery importers" (the `SiteImporter` protocol + the Thingiverse/Printables/MakerWorld strategy table), the `imports` "Data model" row, the "API surface" `imports (create/poll)` fragment, the "Frontend" `/import` + `/settings` rows, the **M5** milestone + *Accept*, and the importer "Risks"/"Verification" bullets before implementing. FULL lines 218 (`class SiteImporter(Protocol):`), 228–229 (Thingiverse/Printables rows), 232 (stream-to-spool → `rev-001_imported`, provenance always stored, ToS note shown once for Printables), 275 (`/import` route detail), and 311–327 (M5 scope/Accept/risks) carry the detail the tasks cite verbatim.

## Global Constraints (bind every task)

- **Git identity (MANDATORY, security-relevant):** every commit is authored by the repo-local git config as `metril <1517921+metril@users.noreply.github.com>`. NEVER use a real name or a real email. NEVER add `Co-Authored-By`, "Generated with", or any AI-attribution trailer of any kind, ever.
- **Branch:** all M5 work on `feat/m5-importers` (branch from `main` at base commit `d0766fa`).
- **Quality gates:** backend `uv run ruff check .` + `uv run ruff format --check .` clean, `uv run pytest` green with pristine output (no stray warnings/log noise in the summary); web `npm run build` (tsc strict) green, `npm run lint` clean, `npm test` green. TDD required for every backend logic task: failing test first, RED/GREEN evidence in the task report. Run backend commands from `backend/`, web commands from `web/`.
- **Real infra in tests (hard rule, unchanged from M1–M4):** PostgreSQL + Redis via testcontainers; Celery eager (existing autouse fixture); real Alembic migration applied. Never `moto`, never a mock SMB/S3, never SQLite, never fakeredis. Backends run for real against their containers.
- **M5 EXCEPTION to the real-infra rule (documented carve-out — SPEC "Verification" concedes "contract tests against recorded fixtures + one live smoke"):** the ONLY mocked edge is the **importer's outbound HTTP**, mocked with **`httpx.MockTransport`** (built into httpx — do NOT add `respx` or any new test dependency) serving **recorded, hand-built JSON fixtures** that match each site's real API shape. Each importer exposes ONE construction seam — a module-level `_client(...)` factory (mirror M4's `_build_printer`) — which tests monkeypatch to return an `httpx.Client(transport=httpx.MockTransport(handler))`. The shared download helper exposes the same seam (`app.importers.download._download_client`). Everything else (DB, Redis, Celery, the whole ingest+glb+thumb pipeline) runs for real in-process. Per importer, ONE **live-network smoke test** is marked `@pytest.mark.live_importer` and **excluded from the default gate** — it is the deferred/manual analog of M4's live-A1 acceptance and never runs in CI.
- **CRITICAL INVARIANTS (bold caps — each enforced AND tested in a named task):**
  - **IMPORTS ATOMIC.** No `Model`/`Revision` row exists until metadata + file-list are validated AND every selected file has been fully streamed to spool. A failure in the fetch or download phase ⇒ `imports.state="failed"`, `imports.model_id=NULL`, and **ZERO** orphan `Model`/`Revision` rows. (Enforced by the download-all-then-create ordering in `import_from_url`; tested in Task 3 and Task 7.)
  - **PAID/CLUB/EXCLUSIVE REJECTED BEFORE ANY DOWNLOAD.** The importer's `fetch_metadata` sets `ImportMetadata.reject_reason`; the task raises on it **before** the download phase, so a paid model never streams a byte and never creates a row. The message is human-readable. (Tested in Task 5 for Printables; the seam is generic.)
  - **THINGIVERSE TOKEN NEVER RETURNED NOR LOGGED.** `GET /api/settings/import-tokens` returns the masked sentinel `"***"` (never the token); a bare `"***"` PUT with nothing stored is rejected 422; the token is read only inside the worker to build an `Authorization` header and is never logged, returned, or placed in `imports.meta`/`error`. (Tested in Task 4.)
  - **A MAKERWORLD URL NEVER CRASHES.** `build_importer_for_url` returns `None` for it; `POST /api/imports` maps it to a clear `422` ("MakerWorld import isn't available yet"); the `/import` UI detects it client-side and shows the friendly message without calling the API. (Tested in Task 3 backend + Task 6 frontend.)
  - **DEFAULT TEST GATE MAKES ZERO REAL NETWORK CALLS.** All importer HTTP in the default gate goes through `httpx.MockTransport`; the only tests that touch the network are `@pytest.mark.live_importer`, which the gate excludes.
- **FROZEN interfaces (defined in Task 1, consumed verbatim in Tasks 3–6 — keep names/signatures exact):**
  - `SiteImporter` Protocol methods: `canonicalize(self, url: str) -> str | None`, `fetch_metadata(self, external_id: str) -> ImportMetadata`, `list_files(self, external_id: str) -> list[ImportFile]`, `resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload`; class attribute `site: ClassVar[ImportSite]`.
  - Dataclasses (fields frozen): `ImportMetadata(site, external_id, source_url, title, description, author, license, cover_url, tags, reject_reason)`; `ImportFile(remote_id, filename, url, size)`; `ResolvedDownload(url, filename, headers)`.
  - Registry names: `IMPORTER_REGISTRY`, `register_importer(importer)`, `build_importer_for_url(url)`, `deferred_site_for_url(url)`.
  - Service/helper names: `app.importers.download.stream_remote_to_spool(...)` + `StagedFile`; `app.services.library.create_imported_model_sync(...)` + `store_imported_file_sync(...)`; `app.services.events.publish_import_event_sync(...)`; `app.services.import_tokens.get_import_tokens_sync(...)`.
- **Version-floor note:** `httpx` is promoted to `[project] dependencies` **bare** (per the project's "bare names unless a specific fix is load-bearing" convention). It moves OUT of `[dependency-groups] dev` — it is now a runtime dep, so it stays available to tests transitively. `uv lock` pins the resolved version (record it in the Task 2 report).
- **No new Alembic migration for `imports`.** The `imports` table + `import_site`/`import_state` enums are already in the baseline migration `2a2ad98de9a4` (`backend/app/models/system.py:16-38`, `backend/app/models/enums.py:84-104`; asserted by `backend/tests/test_migrations.py`). Site-specific import state (cover URL, license string, selected-file list) lives in the existing `imports.meta` JSONB — **no schema change**. If a genuinely new column surfaces, chain an incremental migration off the CURRENT head (`793658394a4d` — run `uv run alembic heads` at plan time; precedent: M3's `793658394a4d_add_model_review_state.py` set `down_revision = "2a2ad98de9a4"`) and keep `test_migrations.py`'s `EXPECTED_TABLES`/`EXPECTED_INDEXES` in sync — but **prefer `meta`**.
- **Provenance columns already exist, unused by any writer today:** `models.source_url/source_site/source_author/source_license/imported_at` (`backend/app/models/library.py:74-78`), already read by `ModelDetail` (`backend/app/schemas/library.py:264-273`). M5 is the first writer; Task 6 adds `source_site` to `ModelSummary` for the gallery badge.
- **New endpoint verbs/paths (SPEC leaves these to M5 — this plan fixes them; all under the auth-gated `protected_router`, NONE flag-gated since MakerWorld is deferred):** `POST /api/imports` (create → `201` `ImportOut`), `GET /api/imports/{id}` (poll → `ImportOut`), `GET /api/imports` (list → `list[ImportOut]`); `GET /api/settings/import-tokens` (masked) + `PUT /api/settings/import-tokens` (merge-on-blank/sentinel).
- **SSE reuse (do not invent a new event type):** import progress reuses the generic `job.updated` event via `publish_import_event_sync`, mirroring M3's `publish_scan_event_sync` — `job_type="import_from_url"`, `subject_type="import"`, `subject_id=<imports.id>`, `job_id=<imports.id>`. The per-file `store_to_backend` jobs keep firing their own `job.updated` (done/failed) exactly as an upload does. No generic `jobs` row is created for the import itself (matches the scan precedent).
- **Test conventions (unchanged):** DB tests against the real Postgres testcontainer; the auth sweep must stay green (the new `/imports` + `/settings/import-tokens` routes register their path params if the sweep enumerates routes); `-m "not e2e and not live_importer"` keeps the unit gate hermetic; `backend/tests/corpus.py`'s `box_stl()`/`box_obj()` are the ready-made real-mesh bytes the fake importer serves.
- **Carried-backlog triage (dispositions binding this milestone):**
  - **`corpus_real/` still empty** → standing request, not blocking; no importer analog needed (cassettes cover the HTTP shapes).
  - **M4 deferreds** (storage-secret Fernet retrofit, `printerd` reconciliation loop, SecretStr hardening, `review_state` gallery badge, `bambulabs-api` version pin) → all remain on the ledger; **none intersect M5 files** → do not touch here. In particular, the Thingiverse token is stored **plaintext-masked** (mirroring the still-plaintext storage secrets), NOT Fernet-encrypted — SPEC attaches "encrypted" only to MakerWorld's token, which is deferred.
  - **M3 deferreds** (S3-walk pathological key, migrate post-cutover state, scan-lock renewal) → do not intersect M5 → untouched.

---

## Task 1: `SiteImporter` Protocol + shared dataclasses + `ImportSite`-keyed registry + fake importer (the contract)

FULL line 218 (`class SiteImporter(Protocol):`) + SPEC "Gallery importers" (`canonicalize`/`fetch_metadata`/`list_files`/`resolve_download`). Lands the contract and the in-memory fake **before** any real-site or orchestration code — every later task is written against these signatures and proven through the fake. **No migration** (`imports` table already exists). No third-party import here (no `httpx` yet — that lands in Task 2), so importing the package is startup-safe.

**Files:**
- Create: `backend/app/importers/__init__.py`, `backend/app/importers/base.py`, `backend/app/importers/registry.py`, `backend/app/importers/fake.py`, `backend/tests/test_importer_registry.py`

**Interfaces (Tasks 3–6 depend on these — keep names exact):** the FROZEN interfaces listed in Global Constraints. `canonicalize` **doubles as site detection AND external-id extraction**: it returns the site's external id (e.g. Thingiverse `"763622"`) when the URL belongs to this importer, else `None`. We use a Python `Protocol` (per FULL line 218) paired with a concrete-instance registry; concrete importers need not subclass it (structural typing) but each declares `site: ClassVar[ImportSite]` for registration — documented in `base.py`.

- [ ] **Step 1 — package + base contract.** Create `app/importers/__init__.py` (empty) and `app/importers/base.py`:
  ```python
  """The SiteImporter contract (SPEC "Gallery importers"; FULL line 218
  ``class SiteImporter(Protocol):``). A structural Protocol -- concrete
  importers (Thingiverse/Printables) do not subclass it; they just satisfy
  the four methods and declare ``site`` for registry keying. The three frozen
  dataclasses are the normalized shapes the orchestration task (Task 3)
  speaks, so no importer leaks a site-specific dict past this boundary."""
  from __future__ import annotations

  from dataclasses import dataclass, field
  from typing import ClassVar, Protocol, runtime_checkable

  from app.models.enums import ImportSite


  @dataclass(frozen=True)
  class ImportMetadata:
      """Normalized model metadata. ``reject_reason`` NON-NULL means the model
      is un-importable (paid/Club/exclusive) -- the task raises on it BEFORE
      any download (Global Constraints "PAID/CLUB/EXCLUSIVE REJECTED")."""
      site: ImportSite
      external_id: str
      source_url: str
      title: str
      description: str | None = None
      author: str | None = None
      license: str | None = None
      cover_url: str | None = None
      tags: tuple[str, ...] = ()
      reject_reason: str | None = None


  @dataclass(frozen=True)
  class ImportFile:
      """One downloadable file. ``url`` carries the site's download URL
      through from ``list_files`` to ``resolve_download`` so the latter need
      not re-fetch (short-TTL URLs are resolved just-in-time when it can't)."""
      remote_id: str
      filename: str
      url: str | None = None
      size: int | None = None


  @dataclass(frozen=True)
  class ResolvedDownload:
      """A ready-to-stream download: a (possibly short-TTL) URL plus any
      per-request headers (e.g. ``Authorization: Bearer`` for Thingiverse)."""
      url: str
      filename: str
      headers: dict[str, str] = field(default_factory=dict)


  def safe_filename(name: str) -> str:
      """Reduce a remote filename to a safe single-segment rel_path: strip any
      directory prefix and leading dots so a hostile ``../`` name can't escape
      the revision directory. (finalize's storage_path is rel_path-derived.)"""
      base = str(name).replace("\\", "/").rsplit("/", 1)[-1].strip()
      base = base.lstrip(".")
      return base or "file"


  @runtime_checkable
  class SiteImporter(Protocol):
      site: ClassVar[ImportSite]

      def canonicalize(self, url: str) -> str | None:
          """Return this site's external id parsed from ``url`` (also the
          site-detection signal: non-None ⇒ 'this URL is mine'), else None."""
          ...

      def fetch_metadata(self, external_id: str) -> ImportMetadata: ...
      def list_files(self, external_id: str) -> list[ImportFile]: ...
      def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload: ...
  ```

- [ ] **Step 2 — registry** `app/importers/registry.py`:
  ```python
  """ImportSite-keyed importer registry (mirrors app.printers.registry).
  ``build_importer_for_url`` is the single site-auto-detection seam the API
  uses. Concrete importers register an INSTANCE at their module bottom;
  Tasks 4/5 add the ``from app.importers import thingiverse``/``printables``
  lines at the BOTTOM of this module so importing the registry triggers
  registration (same pattern as the printers registry importing ``bambu``)."""
  from __future__ import annotations

  from urllib.parse import urlparse

  from app.importers.base import SiteImporter
  from app.models.enums import ImportSite

  IMPORTER_REGISTRY: dict[ImportSite, SiteImporter] = {}

  # MakerWorld is deferred (M5 controller decision). Detect its URLs so the
  # API/UI can answer with a friendly "not available yet" instead of a generic
  # "unsupported URL" -- a MakerWorld URL must NEVER crash (Global Constraints).
  _DEFERRED_HOSTS = {
      "makerworld.com": ImportSite.MAKERWORLD,
      "www.makerworld.com": ImportSite.MAKERWORLD,
  }


  def register_importer(importer: SiteImporter) -> SiteImporter:
      IMPORTER_REGISTRY[importer.site] = importer
      return importer


  def build_importer_for_url(url: str) -> SiteImporter | None:
      for importer in IMPORTER_REGISTRY.values():
          if importer.canonicalize(url) is not None:
              return importer
      return None


  def deferred_site_for_url(url: str) -> ImportSite | None:
      try:
          host = (urlparse(url).hostname or "").lower()
      except ValueError:
          return None
      return _DEFERRED_HOSTS.get(host)
  ```

- [ ] **Step 3 — fake importer** `app/importers/fake.py`:
  ```python
  """In-memory SiteImporter for orchestration tests (M5 carve-out; the mirror
  of M4's FakePrinterAdapter). Holds canned metadata + a ``{filename: bytes}``
  map; ``resolve_download`` hands back ``https://fake.test/dl/<filename>``
  URLs that the test's httpx.MockTransport serves from the SAME byte map.
  NOT auto-registered -- tests register it over a site (default THINGIVERSE)."""
  from __future__ import annotations

  from dataclasses import dataclass, field
  from typing import ClassVar

  from app.importers.base import ImportFile, ImportMetadata, ResolvedDownload
  from app.models.enums import ImportSite

  FAKE_BASE = "https://fake.test/thing/"
  FAKE_DL = "https://fake.test/dl/"


  @dataclass
  class FakeImporter:
      site: ClassVar[ImportSite] = ImportSite.THINGIVERSE
      external_id: str = "42"
      title: str = "Fake Thing"
      description: str | None = "a fake import"
      author: str | None = "fakeuser"
      license: str | None = "CC-BY-4.0"
      cover_url: str | None = "https://fake.test/cover.png"
      tags: tuple[str, ...] = ("fake", "test")
      reject_reason: str | None = None
      files: dict[str, bytes] = field(default_factory=dict)

      def canonicalize(self, url: str) -> str | None:
          if url.startswith(FAKE_BASE):
              return url[len(FAKE_BASE) :] or self.external_id
          return None

      def fetch_metadata(self, external_id: str) -> ImportMetadata:
          return ImportMetadata(
              site=self.site, external_id=external_id,
              source_url=f"{FAKE_BASE}{external_id}", title=self.title,
              description=self.description, author=self.author, license=self.license,
              cover_url=self.cover_url, tags=self.tags, reject_reason=self.reject_reason,
          )

      def list_files(self, external_id: str) -> list[ImportFile]:
          return [
              ImportFile(remote_id=name, filename=name, url=f"{FAKE_DL}{name}", size=len(data))
              for name, data in self.files.items()
          ]

      def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
          return ResolvedDownload(url=file.url or f"{FAKE_DL}{file.filename}", filename=file.filename)
  ```

- [ ] **Step 4 — failing registry test** `backend/tests/test_importer_registry.py`:
  ```python
  import pytest

  from app.importers.base import ImportFile, ImportMetadata, safe_filename
  from app.importers.fake import FAKE_BASE, FakeImporter
  from app.importers.registry import (
      IMPORTER_REGISTRY,
      build_importer_for_url,
      deferred_site_for_url,
      register_importer,
  )
  from app.models.enums import ImportSite


  def test_build_importer_for_url_detects_and_extracts(monkeypatch):
      fake = FakeImporter(external_id="99")
      monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)
      chosen = build_importer_for_url(f"{FAKE_BASE}99")
      assert chosen is fake
      assert chosen.canonicalize(f"{FAKE_BASE}99") == "99"

  def test_build_importer_for_url_unknown_is_none():
      assert build_importer_for_url("https://example.com/whatever") is None

  def test_makerworld_url_is_detected_as_deferred_not_crashing():
      assert build_importer_for_url("https://makerworld.com/en/models/123") is None
      assert deferred_site_for_url("https://makerworld.com/en/models/123") is ImportSite.MAKERWORLD
      assert deferred_site_for_url("https://www.thingiverse.com/thing:763622") is None

  def test_register_importer_keys_on_site(monkeypatch):
      monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, FakeImporter())
      out = register_importer(FakeImporter(title="second"))
      assert IMPORTER_REGISTRY[ImportSite.THINGIVERSE] is out

  def test_fake_metadata_and_files_shape():
      fake = FakeImporter(files={"cube.stl": b"solid\n"})
      meta = fake.fetch_metadata("42")
      assert isinstance(meta, ImportMetadata) and meta.title == "Fake Thing"
      files = fake.list_files("42")
      assert files == [ImportFile(remote_id="cube.stl", filename="cube.stl",
                                  url="https://fake.test/dl/cube.stl", size=6)]

  def test_safe_filename_strips_paths_and_dots():
      assert safe_filename("../../etc/passwd") == "passwd"
      assert safe_filename("a/b/c.stl") == "c.stl"
      assert safe_filename("") == "file"
  ```
  Run: `uv run pytest tests/test_importer_registry.py -v` → RED (`app.importers` missing) until Steps 1–3 land, then GREEN.

- [ ] **Step 5 — run + gates.** `uv run pytest tests/test_importer_registry.py -v` → GREEN. Full suite `uv run pytest` green. `uv run ruff check .` + `uv run ruff format --check .` clean.

- [ ] **Step 6 — commit.** `git add -A && git commit -m "Add SiteImporter protocol, import dataclasses, ImportSite registry, and fake importer"`.

**Accept:** the Protocol + three frozen dataclasses + registry + fake exist; `build_importer_for_url` resolves by URL and returns `None` for unknown/MakerWorld; `deferred_site_for_url` flags a MakerWorld URL; `register_importer` keys on `site`; `safe_filename` neutralizes path-escape names; importing `app.importers.*` pulls in NO third-party HTTP lib.

---

## Task 2: `create_model` provenance + `rev-001_imported` + sync import helpers + the remote-stream-to-spool helper (promote `httpx`)

Surface map §4b (`create_model` gap) + §3a (the ingest seam) + controller decisions 1, 3, 7. Extends the async `create_model` in place with provenance + a configurable first-revision name (decision 1, for the manual API path + naming consistency), and adds the **sync-world** helpers the `import_from_url` Celery task needs (the codebase's established async/sync twin pattern — `create_job` has `create_job_sync`, `get_active_config` has `get_active_config_sync`; a task body runs in `app.tasks.base.sync_session()` and cannot call the async services). Introduces `httpx` as a runtime dep via the shared remote-stream-to-spool helper. **No importer or API code yet** — this is the reusable seam every importer rides.

**Files:**
- Create: `backend/app/importers/download.py`, `backend/tests/test_import_download.py`, `backend/tests/test_library_provenance.py`
- Modify: `backend/pyproject.toml` (promote `httpx`), `backend/app/services/library.py` (extend `create_model`; add sync helpers)

**Interfaces (Tasks 3–5 consume these — keep names exact):**
- `app/importers/download.py`:
  ```python
  @dataclass(frozen=True)
  class StagedFile:
      token: uuid.UUID       # spool token; doubles as the store_to_backend job id
      spool_path: Path
      blob_hash: str
      size: int
      rel_path: str
      kind: BlobKind
      format_: BlobFormat

  def stream_remote_to_spool(settings: Settings, *, url: str, rel_path: str,
                             headers: dict[str, str] | None = None) -> StagedFile
  def _download_client() -> httpx.Client   # the ONE seam tests monkeypatch (MockTransport)
  ```
- `app/services/library.py`:
  ```python
  async def create_model(db, backend, *, name, description,
      source_url=None, source_site=None, source_author=None, source_license=None,
      imported_at=None, initial_revision_name="initial") -> Model      # extended in place
  def create_imported_model_sync(session, backend, *, name, description, source_url,
      source_site, source_author, source_license, imported_at, tags,
      initial_revision_name="imported") -> Model
  def store_imported_file_sync(session, *, model, revision, staged: StagedFile) -> File
  ```

- [ ] **Step 1 — promote `httpx` to a runtime dependency.** In `backend/pyproject.toml`, add `"httpx"` to `[project] dependencies` (after `"cryptography"`) and **remove** the `"httpx"` line from `[dependency-groups] dev`. Run `uv lock && uv sync`. Verify: `uv run python -c "import httpx; print(httpx.__version__)"` prints a version; record the resolved `httpx` version from `uv.lock` in the task report. Confirm the dev group still resolves (`uv run pytest --collect-only -q >/dev/null`).

- [ ] **Step 2 — failing provenance test** `backend/tests/test_library_provenance.py` (async, real backend + DB):
  ```python
  from datetime import UTC, datetime

  import pytest

  from app.models.library import Revision
  from app.services import library


  @pytest.mark.asyncio
  async def test_manual_create_model_still_yields_rev_001_initial(db_session, backend):
      model = await library.create_model(db_session, backend, name="Manual Widget", description=None)
      cur = await db_session.get(Revision, model.current_revision_id)
      assert cur.dir_name == "rev-001_initial" and cur.name == "initial"
      assert model.source_site is None and model.imported_at is None

  @pytest.mark.asyncio
  async def test_create_imported_model_sync_sets_provenance_and_rev_imported(db_session, backend):
      # sync helper uses a SYNC session; drive it against the SAME testcontainer
      # DB via app.tasks.base.sync_session (the worker engine).
      from app.models.library import Model, Revision, Tag
      from app.tasks.base import sync_session

      when = datetime(2026, 7, 7, tzinfo=UTC)
      with sync_session() as s:
          model = library.create_imported_model_sync(
              s, backend, name="Imported Vase", description="from a gallery",
              source_url="https://www.thingiverse.com/thing:763622",
              source_site="thingiverse", source_author="alice", source_license="CC-BY-4.0",
              imported_at=when, tags=["vase", "spiral"], initial_revision_name="imported",
          )
          mid = model.id
      with sync_session() as s:
          m = s.get(Model, mid)
          rev = s.get(Revision, m.current_revision_id)
          assert rev.dir_name == "rev-001_imported" and rev.name == "imported"
          assert m.source_site == "thingiverse" and m.source_author == "alice"
          assert m.source_license == "CC-BY-4.0" and m.imported_at is not None
          assert {t.name for t in m.tags} == {"vase", "spiral"}
  ```
  Run: `uv run pytest tests/test_library_provenance.py -v` → RED (`create_imported_model_sync` missing; `create_model` has no provenance kwargs).

- [ ] **Step 3 — extend the async `create_model`** in `app/services/library.py`. Replace the current signature/body (lines ~160-186) with:
  ```python
  async def create_model(
      db: AsyncSession,
      backend: StorageBackend,
      *,
      name: str,
      description: str | None,
      source_url: str | None = None,
      source_site: str | None = None,
      source_author: str | None = None,
      source_license: str | None = None,
      imported_at: datetime | None = None,
      initial_revision_name: str = "initial",
  ) -> Model:
      slug = await _unique_slug(db, name)
      model = Model(
          slug=slug, name=name, description=description, tags=[],
          source_url=source_url, source_site=source_site, source_author=source_author,
          source_license=source_license, imported_at=imported_at,
      )
      db.add(model)
      await db.flush()
      dir_name = layout.revision_dir_name(1, initial_revision_name)
      revision = Revision(model_id=model.id, number=1, name=initial_revision_name, dir_name=dir_name)
      db.add(revision)
      await db.flush()

      def _write_storage() -> None:
          backend.mkdirs(layout.revision_dir_key(slug, revision.dir_name))
          layout.write_sidecar(backend, model.id, slug, model.name)

      await anyio.to_thread.run_sync(_write_storage)
      model.current_revision_id = revision.id
      await db.commit()
      return model
  ```
  Note the `tags=[]` marks the collection loaded (the existing `MissingGreenlet` guard — keep the original comment). The manual caller in `app/api/models.py:25` passes no new kwargs → defaults preserve `rev-001_initial`/no provenance. **No call-site change needed.**

- [ ] **Step 4 — add the sync import helpers** to `app/services/library.py` (after `create_model`). Add a sync `_unique_slug_sync` and the two helpers:
  ```python
  def _unique_slug_sync(session: SyncSession, name: str) -> str:
      base = layout.slug_for(name)
      slug = base
      suffix = 2
      while session.scalar(select(Model.id).where(Model.slug == slug)) is not None:
          slug = f"{base}-{suffix}"
          suffix += 1
      return slug


  def create_imported_model_sync(
      session: SyncSession,
      backend: StorageBackend,
      *,
      name: str,
      description: str | None,
      source_url: str | None,
      source_site: str | None,
      source_author: str | None,
      source_license: str | None,
      imported_at: datetime | None,
      tags: list[str],
      initial_revision_name: str = "imported",
  ) -> Model:
      """SYNC twin of ``create_model`` for the import worker (app.tasks.base
      sync world). Inserts the Model + first revision WITH provenance, writes
      the storage sidecar, get-or-creates tag rows, and commits atomically --
      called only AFTER every file is staged to spool, so a Model row never
      exists for a failed import (Global Constraints "IMPORTS ATOMIC")."""
      slug = _unique_slug_sync(session, name)
      model = Model(
          slug=slug, name=name, description=description, tags=[],
          source_url=source_url, source_site=source_site, source_author=source_author,
          source_license=source_license, imported_at=imported_at,
      )
      session.add(model)
      session.flush()
      dir_name = layout.revision_dir_name(1, initial_revision_name)
      revision = Revision(model_id=model.id, number=1, name=initial_revision_name, dir_name=dir_name)
      session.add(revision)
      session.flush()
      backend.mkdirs(layout.revision_dir_key(slug, dir_name))
      layout.write_sidecar(backend, model.id, slug, model.name)
      for tag_name in tags:
          tag = session.scalar(select(Tag).where(Tag.name == tag_name))
          if tag is None:
              tag = Tag(name=tag_name)
              session.add(tag)
              session.flush()
          model.tags.append(tag)
      model.current_revision_id = revision.id
      session.commit()
      return model


  def store_imported_file_sync(
      session: SyncSession, *, model: Model, revision: Revision, staged: "StagedFile"
  ) -> File:
      """The §3a ingest seam for one staged import file (SYNC twin of the
      ``finalize_upload`` + ``create_job`` + ``store_to_backend.apply_async``
      sequence ``PUT /uploads`` runs). Upserts the Blob by hash, inserts the
      File (verified_at NULL), then dispatches the SAME store_to_backend job a
      browser upload does -- so glb/thumbs run afterward via the normal
      pipeline. ``staged.token`` is the spool token AND the job id (so a retry
      re-finds the spool), mirroring ``app.api.uploads``."""
      from app.services import jobs as jobs_service
      from app.tasks.ingest import store_to_backend

      blob = session.get(Blob, staged.blob_hash)
      if blob is None:
          blob = Blob(hash=staged.blob_hash, size=staged.size, kind=staged.kind, format=staged.format_)
          session.add(blob)
          try:
              session.flush()
          except IntegrityError:
              session.rollback()
              blob = session.get(Blob, staged.blob_hash)  # concurrent insert of same content
      file = File(
          revision_id=revision.id, blob_hash=staged.blob_hash, rel_path=staged.rel_path,
          storage_path=layout.file_key(model.slug, revision.dir_name, staged.rel_path),
          verified_at=None,
      )
      session.add(file)
      session.commit()
      session.refresh(file)
      job = jobs_service.create_job_sync(
          session, id=staged.token, type="store_to_backend", subject_type="file", subject_id=file.id
      )
      store_to_backend.apply_async(
          args=[str(job.id), file.id, str(staged.spool_path)], task_id=str(job.id)
      )
      return file
  ```
  Add the needed imports at the top of `library.py`: `from sqlalchemy.orm import Session as SyncSession` (alongside the existing `selectinload` import) and a `TYPE_CHECKING` import of `StagedFile` (`from app.importers.download import StagedFile`) so the annotation resolves without a runtime cycle (`store_imported_file_sync` uses the string annotation `"StagedFile"`).

- [ ] **Step 5 — the remote-stream-to-spool helper** `app/importers/download.py`:
  ```python
  """Stream a remote file straight to the upload spool, blake3-hashing while
  it streams -- the importer analog of app.api.uploads' tee-to-spool loop
  (surface map §3a), but reading an httpx streaming response instead of an
  ASGI request body. Runs in the worker's SYNC world. ``_download_client`` is
  the ONE construction seam tests monkeypatch with an httpx.MockTransport
  (Global Constraints M5 EXCEPTION); the default gate makes no real network
  call."""
  from __future__ import annotations

  import uuid
  from dataclasses import dataclass
  from pathlib import Path

  import httpx
  from blake3 import blake3

  from app.config import Settings
  from app.models.enums import BlobFormat, BlobKind
  from app.services import layout, spool

  _CHUNK_SIZE = 1024 * 1024  # 1 MiB, matching store_to_backend's read chunking
  _TIMEOUT = httpx.Timeout(30.0, read=300.0)
  _USER_AGENT = "3d-model-manager/1.0 (+https://github.com/metril/3d-model-manager)"


  @dataclass(frozen=True)
  class StagedFile:
      token: uuid.UUID
      spool_path: Path
      blob_hash: str
      size: int
      rel_path: str
      kind: BlobKind
      format_: BlobFormat


  def _download_client() -> httpx.Client:
      return httpx.Client(follow_redirects=True, timeout=_TIMEOUT,
                          headers={"User-Agent": _USER_AGENT})


  def stream_remote_to_spool(
      settings: Settings, *, url: str, rel_path: str, headers: dict[str, str] | None = None
  ) -> StagedFile:
      spool.ensure_spool_dir(settings)
      token = uuid.uuid4()
      path = spool.spool_path(settings, token)
      hasher = blake3()
      size = 0
      try:
          with _download_client() as client:
              with client.stream("GET", url, headers=headers or {}) as resp:
                  resp.raise_for_status()
                  with path.open("wb") as fh:
                      for chunk in resp.iter_bytes(_CHUNK_SIZE):
                          if not chunk:
                              continue
                          hasher.update(chunk)
                          size += len(chunk)
                          fh.write(chunk)
      except BaseException:
          path.unlink(missing_ok=True)  # never orphan a spool file on a failed stream
          raise
      if size == 0:
          path.unlink(missing_ok=True)
          raise ValueError(f"remote file {rel_path!r} was empty")
      kind, format_ = layout.infer_blob_kind_format(rel_path)
      return StagedFile(token=token, spool_path=path, blob_hash=hasher.hexdigest(),
                        size=size, rel_path=rel_path, kind=kind, format_=format_)
  ```

- [ ] **Step 6 — failing download test** `backend/tests/test_import_download.py`:
  ```python
  import httpx
  import pytest

  from app.config import get_settings
  from app.importers import download


  def _mock_client(body: bytes, *, status: int = 200):
      def handler(request: httpx.Request) -> httpx.Response:
          return httpx.Response(status, content=body)
      return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


  def test_stream_remote_to_spool_hashes_and_sizes(monkeypatch, data_dir):
      import blake3 as _b3

      body = b"solid cube\nendsolid cube\n"
      monkeypatch.setattr(download, "_download_client", lambda: _mock_client(body))
      get_settings.cache_clear()
      staged = download.stream_remote_to_spool(
          get_settings(), url="https://files.test/cube.stl", rel_path="cube.stl"
      )
      assert staged.size == len(body)
      assert staged.blob_hash == _b3.blake3(body).hexdigest()
      assert staged.rel_path == "cube.stl" and staged.spool_path.read_bytes() == body

  def test_stream_remote_to_spool_http_error_leaves_no_spool(monkeypatch, data_dir):
      monkeypatch.setattr(download, "_download_client", lambda: _mock_client(b"nope", status=404))
      get_settings.cache_clear()
      with pytest.raises(httpx.HTTPStatusError):
          download.stream_remote_to_spool(
              get_settings(), url="https://files.test/missing.stl", rel_path="missing.stl"
          )
      # spool dir exists but holds no leftover file
      spooled = list((get_settings().data_dir / "spool").glob("*"))
      assert spooled == []
  ```
  Run: `uv run pytest tests/test_import_download.py tests/test_library_provenance.py -v` → GREEN after Steps 3–5.

- [ ] **Step 7 — run + gates.** Full `uv run pytest` green (the extended `create_model` keeps every existing models/upload test passing). Ruff clean + format check clean.

- [ ] **Step 8 — commit.** `git add -A && git commit -m "Promote httpx to runtime; extend create_model with provenance; add sync import helpers and remote-stream-to-spool"`.

**Accept:** `create_model` accepts optional provenance + `initial_revision_name` and the manual path still yields `rev-001_initial`; `create_imported_model_sync` writes provenance + tags + `rev-001_imported` in one sync commit; `store_imported_file_sync` upserts the blob and dispatches the same `store_to_backend` job an upload does; `stream_remote_to_spool` tees a streaming httpx response to spool with a matching blake3 hash and leaves no spool file on failure; `httpx` is a runtime dep.

---

## Task 3: `/api/imports` endpoints + `import_from_url` orchestration task (site-agnostic, driven by the fake importer)

SPEC "API surface" (`imports (create/poll)`) + controller decisions 3 & 4. Ships the import lifecycle end-to-end — `POST`/`GET`/list endpoints, the `import_from_url` Celery task with the **download-all-then-create atomicity**, and the `job.updated` SSE wiring — **built and proven against the Task-1 fake importer** (via `httpx.MockTransport`) so the orchestration is correct before any real-site parsing lands. **No Thingiverse/Printables code in this task.**

**Files:**
- Create: `backend/app/schemas/imports.py`, `backend/app/api/imports.py`, `backend/app/tasks/importing.py`, `backend/tests/importer_fixtures.py`, `backend/tests/test_imports_api.py`, `backend/tests/test_import_from_url.py`
- Modify: `backend/app/services/events.py` (add `publish_import_event_sync`), `backend/app/api/__init__.py` (mount the `imports` router), `backend/tests/conftest.py` (register the `tests.importer_fixtures` plugin)

**Interfaces (Tasks 4–7 consume these — keep names exact):**
- `app/schemas/imports.py`: `ImportCreate(url)`, `ImportOut(id, url, site, external_id, state, model_id, error, meta, created_at, updated_at)` + `from_model`.
- `app/tasks/importing.py`: `@celery_app.task import_from_url(import_id: int) -> None`.
- `app/services/events.py`: `publish_import_event_sync(redis_url, import_id, state)`.
- `tests/importer_fixtures.py`: fixture `fake_import(monkeypatch)` → registers a configurable `FakeImporter` over `ImportSite.THINGIVERSE` in `IMPORTER_REGISTRY` **and** points `download._download_client` at an `httpx.MockTransport` serving the fake's byte map; returns the `FakeImporter` so a test can set `.files`/`.reject_reason`.

- [ ] **Step 1 — SSE publish helper.** In `app/services/events.py`, after `publish_scan_event_sync`, add (mirrors it exactly):
  ```python
  def publish_import_event_sync(redis_url: str, import_id: int, state: str) -> None:
      """Publish a gallery import's state as a ``job.updated`` event (M5;
      mirrors ``publish_scan_event_sync``). ``job_type="import_from_url"``,
      ``subject_type="import"`` -- the frontend's ``job.updated`` handler adds
      one branch keyed on that job_type to invalidate ``["imports"]``/
      ``["models"]``; no new SSE event type."""
      publish_job_event_sync(
          redis_url, job_id=str(import_id), job_type="import_from_url", state=state,
          subject_type="import", subject_id=import_id,
      )
  ```

- [ ] **Step 2 — schemas** `app/schemas/imports.py`:
  ```python
  from __future__ import annotations

  from datetime import datetime
  from typing import TYPE_CHECKING, Annotated

  from pydantic import BaseModel, StringConstraints

  if TYPE_CHECKING:
      from app.models.system import Import

  NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


  class ImportCreate(BaseModel):
      url: NonEmptyStr


  class ImportOut(BaseModel):
      id: int
      url: str
      site: str
      external_id: str | None
      state: str
      model_id: int | None
      error: str | None
      meta: dict | None
      created_at: datetime
      updated_at: datetime

      @classmethod
      def from_model(cls, imp: Import) -> ImportOut:
          return cls(
              id=imp.id, url=imp.url, site=imp.site, external_id=imp.external_id,
              state=imp.state, model_id=imp.model_id, error=imp.error, meta=imp.meta,
              created_at=imp.created_at, updated_at=imp.updated_at,
          )
  ```

- [ ] **Step 3 — the orchestration task** `app/tasks/importing.py`:
  ```python
  """``import_from_url`` Celery task (SPEC "Gallery importers"; controller
  decision 3). Site-agnostic orchestration over the SiteImporter contract,
  in the worker's SYNC world (app.tasks.base):

    (a) FETCHING  -> fetch_metadata + list_files; reject paid/Club/exclusive
                     (metadata.reject_reason) BEFORE any download.
    (b) DOWNLOADING-> stream EVERY file to spool (blake3 each). ALL must succeed.
    (c) create model+revision (provenance) + per-file finalize/store dispatch;
        set imports.model_id; DONE.

  Any failure in (a)/(b) ⇒ FAILED, model_id NULL, ZERO orphan Model/Revision
  rows (Global Constraints "IMPORTS ATOMIC"). A rejected/failed import is a
  NORMAL terminal state recorded on the row -- the task swallows the exception
  (after marking FAILED) rather than re-raising, so ``POST /imports`` returns
  the created row and the client polls its state (in eager test mode the task
  runs inline, so this also keeps POST from 500ing on an expected rejection)."""
  from __future__ import annotations

  import logging
  from datetime import UTC, datetime

  from app.config import get_settings
  from app.importers import download
  from app.importers.registry import IMPORTER_REGISTRY
  from app.models.enums import ImportState
  from app.models.system import Import
  from app.services import events, library
  from app.services.storage_config import resolve_backend_sync
  from app.tasks import base
  from app.tasks.celery_app import celery_app

  logger = logging.getLogger(__name__)


  class ImportRejected(Exception):
      """Un-importable model (paid/Club/exclusive, or no files) -- recorded as
      a clean FAILED with a human message, never a crash."""


  def _set_state(session, imp: Import, state: ImportState, *, error: str | None = None) -> None:
      imp.state = state
      if error is not None:
          imp.error = error
      session.commit()
      events.publish_import_event_sync(get_settings().redis_url, imp.id, state.value)


  @celery_app.task(name="app.tasks.importing.import_from_url")
  def import_from_url(import_id: int) -> None:
      settings = get_settings()
      staged: list[download.StagedFile] = []
      try:
          with base.sync_session() as s:
              imp = s.get(Import, import_id)
              if imp is None:
                  raise LookupError(f"import {import_id} not found")
              importer = IMPORTER_REGISTRY.get(imp.site)
              if importer is None:
                  raise ImportRejected(f"no importer registered for {imp.site}")
              external_id = imp.external_id or ""
              _set_state(s, imp, ImportState.FETCHING)

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
              resolved = importer.resolve_download(external_id, f)
              staged.append(
                  download.stream_remote_to_spool(
                      settings, url=resolved.url, rel_path=resolved.filename,
                      headers=resolved.headers or None,
                  )
              )

          with base.sync_session() as s:
              from app.models.library import Revision

              backend = resolve_backend_sync(s, settings)
              model = library.create_imported_model_sync(
                  s, backend, name=meta.title, description=meta.description,
                  source_url=meta.source_url, source_site=meta.site.value,
                  source_author=meta.author, source_license=meta.license,
                  imported_at=datetime.now(UTC), tags=list(meta.tags),
                  initial_revision_name="imported",
              )
              rev = s.get(Revision, model.current_revision_id)
              for sf in staged:
                  library.store_imported_file_sync(s, model=model, revision=rev, staged=sf)
              imp = s.get(Import, import_id)
              imp.model_id = model.id
              imp.meta = {"cover_url": meta.cover_url, "license": meta.license,
                          "files": [sf.rel_path for sf in staged]}
              _set_state(s, imp, ImportState.DONE)
      except Exception as exc:  # noqa: BLE001 -- failure is a recorded terminal state, not a crash
          for sf in staged:
              sf.spool_path.unlink(missing_ok=True)
          message = str(exc) if isinstance(exc, ImportRejected) else f"import failed: {exc}"
          if not isinstance(exc, ImportRejected):
              logger.warning("import %s failed", import_id, exc_info=True)
          with base.sync_session() as s:
              imp = s.get(Import, import_id)
              if imp is not None:
                  imp.model_id = None
                  _set_state(s, imp, ImportState.FAILED, error=message)
  ```
  **Note:** phase (c) loads the current revision explicitly (`rev = s.get(Revision, model.current_revision_id)`) rather than touching the lazy `model.revisions` relationship — the sync session is closed right after, so no lazy load must be left pending.

- [ ] **Step 4 — API** `app/api/imports.py`:
  ```python
  """Gallery import endpoints (SPEC "API surface": imports (create/poll)).
  POST detects the site from the URL, creates a ``pending`` Import row, and
  dispatches ``import_from_url``; GET/{id} + list poll the row (the primary
  read path -- richer than the generic jobs row). A MakerWorld URL yields a
  friendly 422 (deferred), never a crash."""
  from __future__ import annotations

  from fastapi import APIRouter, Depends, HTTPException, status
  from sqlalchemy import select
  from sqlalchemy.ext.asyncio import AsyncSession

  from app.db import get_db
  from app.importers.registry import build_importer_for_url, deferred_site_for_url
  from app.models.enums import ImportSite, ImportState
  from app.models.system import Import
  from app.schemas.imports import ImportCreate, ImportOut
  from app.tasks.importing import import_from_url

  router = APIRouter(prefix="/imports", tags=["imports"])


  @router.post("", status_code=status.HTTP_201_CREATED, response_model=ImportOut)
  async def create_import(payload: ImportCreate, db: AsyncSession = Depends(get_db)) -> ImportOut:
      url = payload.url
      importer = build_importer_for_url(url)
      if importer is None:
          if deferred_site_for_url(url) is ImportSite.MAKERWORLD:
              raise HTTPException(
                  status.HTTP_422_UNPROCESSABLE_CONTENT,
                  "MakerWorld import isn't available yet.",
              )
          raise HTTPException(
              status.HTTP_422_UNPROCESSABLE_CONTENT,
              "Unsupported URL -- paste a Thingiverse or Printables model link.",
          )
      external_id = importer.canonicalize(url)
      imp = Import(url=url, site=importer.site, external_id=external_id, state=ImportState.PENDING)
      db.add(imp)
      await db.commit()
      await db.refresh(imp)

      import_from_url.apply_async(args=[imp.id], task_id=f"import-{imp.id}")

      # Under eager Celery (tests) the line above ran the whole import inline
      # through its own SYNC session, driving the row to done/failed -- refresh
      # so this async session hands back the terminal state, not the stale
      # "pending" snapshot (same reasoning as app.api.settings.migrate).
      await db.refresh(imp)
      return ImportOut.from_model(imp)


  @router.get("", response_model=list[ImportOut])
  async def list_imports(limit: int = 50, db: AsyncSession = Depends(get_db)) -> list[ImportOut]:
      rows = (
          await db.execute(select(Import).order_by(Import.created_at.desc()).limit(limit))
      ).scalars().all()
      return [ImportOut.from_model(r) for r in rows]


  @router.get("/{import_id}", response_model=ImportOut)
  async def get_import(import_id: int, db: AsyncSession = Depends(get_db)) -> ImportOut:
      imp = await db.get(Import, import_id)
      if imp is None:
          raise HTTPException(status.HTTP_404_NOT_FOUND, f"import {import_id} not found")
      return ImportOut.from_model(imp)
  ```
  Mount it in `app/api/__init__.py`: add `imports` to the `from app.api import (...)` list and `protected_router.include_router(imports.router)` alongside the others. If the auth-sweep test enumerates routes with path params, add `/imports/{import_id}` with a sample id there.

- [ ] **Step 5 — shared fixture** `backend/tests/importer_fixtures.py`:
  ```python
  """Import test fixtures (M5 carve-out). Wires a configurable FakeImporter
  into the ImportSite registry AND points the download helper's client seam at
  an httpx.MockTransport serving the fake's byte map -- so a full POST->task->
  poll->model flow runs with ZERO real network. Registered from conftest's
  pytest_plugins."""
  from __future__ import annotations

  import httpx
  import pytest

  from app.importers import download
  from app.importers.fake import FAKE_DL, FakeImporter
  from app.importers.registry import IMPORTER_REGISTRY
  from app.models.enums import ImportSite


  @pytest.fixture
  def fake_import(monkeypatch: pytest.MonkeyPatch) -> FakeImporter:
      fake = FakeImporter()
      monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

      def handler(request: httpx.Request) -> httpx.Response:
          name = str(request.url).removeprefix(FAKE_DL)
          if name in fake.files:
              return httpx.Response(200, content=fake.files[name])
          return httpx.Response(404, text="not found")

      monkeypatch.setattr(
          download, "_download_client",
          lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
      )
      return fake
  ```
  In `tests/conftest.py` change `pytest_plugins = ("tests.storage_containers", "tests.printer_fixtures")` to `pytest_plugins = ("tests.storage_containers", "tests.printer_fixtures", "tests.importer_fixtures")`.

- [ ] **Step 6 — API + orchestration tests** `backend/tests/test_imports_api.py`:
  ```python
  import pytest

  from tests import corpus


  @pytest.mark.asyncio
  async def test_makerworld_url_is_rejected_not_crashed(authenticated_client, library_root, data_dir):
      r = await authenticated_client.post(
          "/api/imports", json={"url": "https://makerworld.com/en/models/999"}
      )
      assert r.status_code == 422 and "MakerWorld" in r.json()["detail"]

  @pytest.mark.asyncio
  async def test_unsupported_url_is_rejected(authenticated_client, library_root, data_dir):
      r = await authenticated_client.post("/api/imports", json={"url": "https://example.com/x"})
      assert r.status_code == 422

  @pytest.mark.asyncio
  async def test_full_import_flow_creates_model(authenticated_client, library_root, data_dir, fake_import):
      fake_import.files = {"cube.stl": corpus.box_stl()}
      r = await authenticated_client.post("/api/imports", json={"url": "https://fake.test/thing/42"})
      assert r.status_code == 201, r.text
      body = r.json()
      # eager task ran inline -> already terminal
      assert body["state"] == "done" and body["model_id"] is not None
      assert body["site"] == "thingiverse" and body["external_id"] == "42"

      poll = await authenticated_client.get(f"/api/imports/{body['id']}")
      assert poll.json()["state"] == "done"

      gallery = await authenticated_client.get("/api/models")
      names = [m["name"] for m in gallery.json()["items"]]
      assert "Fake Thing" in names

  @pytest.mark.asyncio
  async def test_rejected_import_leaves_no_model(authenticated_client, library_root, data_dir, fake_import):
      fake_import.reject_reason = "This is a paid model and can't be imported"
      fake_import.files = {"cube.stl": corpus.box_stl()}
      r = await authenticated_client.post("/api/imports", json={"url": "https://fake.test/thing/42"})
      assert r.status_code == 201
      body = r.json()
      assert body["state"] == "failed" and body["model_id"] is None
      assert "paid" in body["error"]
      # atomicity: no model created
      gallery = await authenticated_client.get("/api/models")
      assert gallery.json()["items"] == []
  ```
  `backend/tests/test_import_from_url.py` (drives the task directly for the download-failure atomicity path — the fake's file map serves 404 for a name it doesn't hold):
  ```python
  import httpx
  import pytest
  from sqlalchemy import func, select

  from app.importers import download
  from app.importers.fake import FakeImporter
  from app.importers.registry import IMPORTER_REGISTRY
  from app.models.enums import ImportSite, ImportState
  from app.models.library import Model
  from app.models.system import Import
  from app.tasks.importing import import_from_url


  @pytest.mark.asyncio
  async def test_download_failure_marks_failed_no_orphan_rows(
      db_session, library_root, data_dir, monkeypatch
  ):
      # A fake whose list_files advertises a file the transport 404s.
      fake = FakeImporter(files={"ghost.stl": b""})
      monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

      def handler(request: httpx.Request) -> httpx.Response:
          return httpx.Response(404, text="gone")

      monkeypatch.setattr(
          download, "_download_client",
          lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
      )
      imp = Import(url="https://fake.test/thing/42", site=ImportSite.THINGIVERSE,
                   external_id="42", state=ImportState.PENDING)
      db_session.add(imp)
      await db_session.commit()
      await db_session.refresh(imp)

      import_from_url(imp.id)  # eager, sync

      await db_session.refresh(imp)
      assert imp.state == ImportState.FAILED and imp.model_id is None
      count = await db_session.scalar(select(func.count()).select_from(Model))
      assert count == 0
  ```
  Run: `uv run pytest tests/test_imports_api.py tests/test_import_from_url.py -v` → GREEN.

- [ ] **Step 7 — run + gates.** Full `uv run pytest` green (pristine output — the task's `logger.warning` only fires on unexpected errors, which these tests don't trigger). Ruff clean + format check clean.

- [ ] **Step 8 — commit.** `git add -A && git commit -m "Add /api/imports endpoints and the site-agnostic import_from_url orchestration task"`.

**Accept:** `POST /api/imports` detects the site, creates a `pending` row, dispatches the task, and returns the (eager-terminal, in tests) row; a MakerWorld/unknown URL yields a clean `422`; the full fake-driven flow produces a `done` import + a real gallery model; a rejected import is `failed` with `model_id=NULL` and no model; a mid-download failure is `failed` with **zero** orphan `Model` rows.

---

## Task 4: Thingiverse importer + app-token Settings storage (plaintext-masked)

SPEC "Gallery importers" Thingiverse row + FULL line 228 (`GET /things/{id}`, `zip_data.files[]/images[]`, `Authorization: Bearer`, "Map license strings manually") + controller decision 2. Implements the importer over the official REST API and the token storage that feeds its `Authorization` header, with a recorded-fixture contract test. The token is stored **plaintext-masked** (mirroring storage secrets + `settings.py`'s `_merge_stored_secrets`), never Fernet-encrypted (SPEC reserves "encrypted" for MakerWorld, deferred), and **NEVER returned in a GET or logged**.

**Files:**
- Create: `backend/app/services/import_tokens.py`, `backend/app/importers/thingiverse.py`, `backend/tests/cassettes/thingiverse_fixtures.py`, `backend/tests/test_thingiverse_importer.py`, `backend/tests/test_import_tokens_api.py`
- Modify: `backend/app/importers/registry.py` (register `thingiverse` at the bottom), `backend/app/api/settings.py` (add `/import-tokens` GET+PUT), `backend/app/schemas/imports.py` (`ImportTokensIn`/`ImportTokensOut`), `backend/tests/cassettes/__init__.py` (create if absent)

**Interfaces (Tasks 6–7 consume these — keep names exact):**
- `app/services/import_tokens.py`: `SETTINGS_KEY = "import_tokens"`; `class ImportTokens(BaseModel): thingiverse_token: str | None = None`; `get_import_tokens(db) -> ImportTokens` (async), `get_import_tokens_sync(session) -> ImportTokens`, `set_thingiverse_token(db, token: str | None) -> None`.
- `app/importers/thingiverse.py`: `@register_importer`-instanced `ThingiverseImporter` (`site = ImportSite.THINGIVERSE`); module seam `_client(token: str | None) -> httpx.Client` (tests monkeypatch this).
- `app/schemas/imports.py`: `ImportTokensIn(thingiverse_token: str = "")`, `ImportTokensOut(thingiverse_token: str)` (the value is `"***"` when set, else `""`).

- [ ] **Step 1 — token service** `app/services/import_tokens.py` (mirrors `app/services/storage_config.py`):
  ```python
  """Gallery-import site tokens (SPEC Thingiverse "user-supplied app token in
  Settings"). Stored in the ``settings`` table under key ``import_tokens`` as
  ``{"thingiverse_token": "..."}`` -- plaintext, masked on read at the API
  layer (controller decision 2; same posture as storage secrets). The token is
  read ONLY inside the worker to build an Authorization header; never returned
  by a GET, never logged."""
  from __future__ import annotations

  from pydantic import BaseModel
  from sqlalchemy.ext.asyncio import AsyncSession
  from sqlalchemy.orm import Session as SyncSession

  from app.models import Setting

  SETTINGS_KEY = "import_tokens"


  class ImportTokens(BaseModel):
      thingiverse_token: str | None = None


  async def get_import_tokens(db: AsyncSession) -> ImportTokens:
      row = await db.get(Setting, SETTINGS_KEY)
      return ImportTokens() if row is None else ImportTokens(**row.value)


  def get_import_tokens_sync(session: SyncSession) -> ImportTokens:
      row = session.get(Setting, SETTINGS_KEY)
      return ImportTokens() if row is None else ImportTokens(**row.value)


  async def set_thingiverse_token(db: AsyncSession, token: str | None) -> None:
      tokens = await get_import_tokens(db)
      tokens.thingiverse_token = token
      row = await db.get(Setting, SETTINGS_KEY)
      value = tokens.model_dump()
      if row is None:
          db.add(Setting(key=SETTINGS_KEY, value=value))
      else:
          row.value = value
      await db.commit()
  ```

- [ ] **Step 2 — token API schemas + failing API test.** Append to `app/schemas/imports.py`:
  ```python
  class ImportTokensIn(BaseModel):
      thingiverse_token: str = ""


  class ImportTokensOut(BaseModel):
      thingiverse_token: str  # "***" when a token is stored, "" otherwise -- never the real value
  ```
  `backend/tests/test_import_tokens_api.py`:
  ```python
  import pytest


  @pytest.mark.asyncio
  async def test_get_tokens_empty(authenticated_client):
      r = await authenticated_client.get("/api/settings/import-tokens")
      assert r.status_code == 200 and r.json() == {"thingiverse_token": ""}

  @pytest.mark.asyncio
  async def test_put_and_mask_roundtrip(authenticated_client):
      put = await authenticated_client.put(
          "/api/settings/import-tokens", json={"thingiverse_token": "tok-abc-123"}
      )
      assert put.status_code == 200 and put.json() == {"thingiverse_token": "***"}
      # GET never returns the real token
      got = await authenticated_client.get("/api/settings/import-tokens")
      assert got.json() == {"thingiverse_token": "***"}

  @pytest.mark.asyncio
  async def test_blank_edit_keeps_stored(authenticated_client):
      await authenticated_client.put("/api/settings/import-tokens", json={"thingiverse_token": "keepme"})
      # a blank submit must not wipe the stored token
      r = await authenticated_client.put("/api/settings/import-tokens", json={"thingiverse_token": ""})
      assert r.json() == {"thingiverse_token": "***"}

  @pytest.mark.asyncio
  async def test_sentinel_edit_keeps_stored(authenticated_client):
      await authenticated_client.put("/api/settings/import-tokens", json={"thingiverse_token": "keepme"})
      r = await authenticated_client.put("/api/settings/import-tokens", json={"thingiverse_token": "***"})
      assert r.json() == {"thingiverse_token": "***"}

  @pytest.mark.asyncio
  async def test_bare_sentinel_with_nothing_stored_is_422(authenticated_client):
      r = await authenticated_client.put("/api/settings/import-tokens", json={"thingiverse_token": "***"})
      assert r.status_code == 422
  ```
  Run → RED (no `/import-tokens` route). 

- [ ] **Step 3 — token API endpoints.** In `app/api/settings.py`, import `from app.services import import_tokens` and `from app.schemas.imports import ImportTokensIn, ImportTokensOut`, then add (reuses the module's existing `_REDACTED_SENTINEL = "***"`):
  ```python
  @router.get("/import-tokens", response_model=ImportTokensOut)
  async def get_import_tokens_settings(db: AsyncSession = Depends(get_db)) -> ImportTokensOut:
      tokens = await import_tokens.get_import_tokens(db)
      return ImportTokensOut(thingiverse_token=_REDACTED_SENTINEL if tokens.thingiverse_token else "")


  @router.put("/import-tokens", response_model=ImportTokensOut)
  async def put_import_tokens_settings(
      payload: ImportTokensIn, db: AsyncSession = Depends(get_db)
  ) -> ImportTokensOut:
      """Merge-on-blank/sentinel, mirroring ``_merge_stored_secrets``: a blank
      or ``"***"`` submit keeps the stored token; a bare ``"***"`` with nothing
      stored is rejected 422 (never persist the placeholder as a credential);
      a real value replaces it."""
      incoming = (payload.thingiverse_token or "").strip()
      stored = (await import_tokens.get_import_tokens(db)).thingiverse_token or ""
      if incoming in ("", _REDACTED_SENTINEL):
          if stored:
              value: str | None = stored
          elif incoming == _REDACTED_SENTINEL:
              raise HTTPException(
                  status.HTTP_422_UNPROCESSABLE_CONTENT,
                  'Cannot set the token to the redaction placeholder "***"; enter the real token.',
              )
          else:
              value = None  # explicit clear when nothing stored + blank submit
      else:
          value = incoming
      await import_tokens.set_thingiverse_token(db, value)
      return ImportTokensOut(thingiverse_token=_REDACTED_SENTINEL if value else "")
  ```
  Run `uv run pytest tests/test_import_tokens_api.py -v` → GREEN.

- [ ] **Step 4 — cassette** `backend/tests/cassettes/__init__.py` (empty, create if absent) and `backend/tests/cassettes/thingiverse_fixtures.py` — a hand-built `GET /things/{id}` body matching the real Thingiverse shape (`zip_data.files[]/images[]`), using the real, stable thing **763622** (Marvin keychain):
  ```python
  """Recorded GET /things/{id} body for a real, stable Thingiverse thing
  (763622 "Marvin"). Hand-built to match the real API's zip_data.files[]/
  images[] shape (SPEC/FULL line 228). Drives the Thingiverse importer's
  parse/normalize logic with no network (M5 EXCEPTION)."""

  THING_ID = "763622"

  THING_763622 = {
      "id": 763622,
      "name": "Marvin (keychain)",
      "description": "The MyMiniFactory mascot.",
      "creator": {"name": "makerbot"},
      "license": "Creative Commons - Attribution",
      "tags": [{"name": "keychain"}, {"name": "marvin"}],
      "zip_data": {
          "files": [
              {"name": "Marvin.stl", "size": 204800,
               "download_url": "https://cdn.thingiverse.com/assets/aa/marvin.stl"},
              {"name": "Marvin_v2.stl", "size": 210000,
               "download_url": "https://cdn.thingiverse.com/assets/bb/marvin_v2.stl"},
          ],
          "images": [
              {"name": "cover.jpg", "url": "https://cdn.thingiverse.com/renders/cover.jpg"},
          ],
      },
  }
  ```

- [ ] **Step 5 — the importer** `app/importers/thingiverse.py`:
  ```python
  """Thingiverse importer over the official REST API (SPEC/FULL line 228:
  GET /things/{id}, zip_data.files[]/images[], Authorization: Bearer). The
  app token is read from Settings (import_tokens) inside the worker. License
  strings are mapped manually (FULL: "Manyfold distrusts the field"). ``_client``
  is the ONE seam tests monkeypatch with an httpx.MockTransport."""
  from __future__ import annotations

  import re
  from typing import ClassVar

  import httpx

  from app.importers.base import ImportFile, ImportMetadata, ResolvedDownload, safe_filename
  from app.importers.registry import register_importer
  from app.models.enums import ImportSite

  _BASE_URL = "https://api.thingiverse.com"
  _URL_RE = re.compile(r"thingiverse\.com/(?:thing:|.*?[?&]thing=)(\d+)", re.IGNORECASE)
  _UA = "3d-model-manager/1.0 (+https://github.com/metril/3d-model-manager)"

  # Manual license map (FULL line 228). Falls back to the raw string.
  _LICENSE_MAP = {
      "creative commons - attribution": "CC-BY-4.0",
      "creative commons - attribution - share alike": "CC-BY-SA-4.0",
      "creative commons - attribution - no derivatives": "CC-BY-ND-4.0",
      "creative commons - attribution - non-commercial": "CC-BY-NC-4.0",
      "creative commons - public domain dedication": "CC0-1.0",
      "public domain": "CC0-1.0",
  }


  def _client(token: str | None) -> httpx.Client:
      headers = {"User-Agent": _UA}
      if token:
          headers["Authorization"] = f"Bearer {token}"
      return httpx.Client(base_url=_BASE_URL, headers=headers, timeout=30.0, follow_redirects=True)


  def _map_license(raw: str | None) -> str | None:
      if not raw:
          return None
      return _LICENSE_MAP.get(raw.strip().lower(), raw)


  def _token() -> str | None:
      from app.services.import_tokens import get_import_tokens_sync
      from app.tasks.base import sync_session

      with sync_session() as s:
          return get_import_tokens_sync(s).thingiverse_token


  class ThingiverseImporter:
      site: ClassVar[ImportSite] = ImportSite.THINGIVERSE

      def canonicalize(self, url: str) -> str | None:
          m = _URL_RE.search(url)
          return m.group(1) if m else None

      def _thing(self, external_id: str) -> dict:
          with _client(_token()) as c:
              r = c.get(f"/things/{external_id}")
              r.raise_for_status()
              return r.json()

      def fetch_metadata(self, external_id: str) -> ImportMetadata:
          d = self._thing(external_id)
          images = (d.get("zip_data") or {}).get("images") or []
          return ImportMetadata(
              site=self.site, external_id=str(external_id),
              source_url=f"https://www.thingiverse.com/thing:{external_id}",
              title=d.get("name") or f"thing {external_id}",
              description=d.get("description"),
              author=(d.get("creator") or {}).get("name"),
              license=_map_license(d.get("license")),
              cover_url=images[0].get("url") if images else None,
              tags=tuple(t["name"] for t in d.get("tags", []) if t.get("name")),
          )

      def list_files(self, external_id: str) -> list[ImportFile]:
          d = self._thing(external_id)
          files = (d.get("zip_data") or {}).get("files") or []
          return [
              ImportFile(remote_id=str(f.get("name")), filename=safe_filename(f.get("name")),
                         url=f.get("download_url"), size=f.get("size"))
              for f in files if f.get("name") and f.get("download_url")
          ]

      def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
          token = _token()
          headers = {"Authorization": f"Bearer {token}"} if token else {}
          return ResolvedDownload(url=file.url or "", filename=file.filename, headers=headers)


  register_importer(ThingiverseImporter())
  ```
  At the BOTTOM of `app/importers/registry.py` add: `from app.importers import thingiverse as _thingiverse  # noqa: E402,F401  (registers thingiverse)`.

- [ ] **Step 6 — contract test** `backend/tests/test_thingiverse_importer.py`:
  ```python
  import httpx
  import pytest

  from app.importers import thingiverse
  from app.importers.base import ImportFile
  from app.importers.thingiverse import ThingiverseImporter
  from app.models.enums import ImportSite
  from tests.cassettes import thingiverse_fixtures as fx


  def _mock_client(cassette):
      def handler(request: httpx.Request) -> httpx.Response:
          assert request.url.path == f"/things/{fx.THING_ID}"
          return httpx.Response(200, json=cassette)
      return httpx.Client(base_url="https://api.thingiverse.com",
                          transport=httpx.MockTransport(handler))


  @pytest.fixture
  def imp(monkeypatch):
      monkeypatch.setattr(thingiverse, "_client", lambda token=None: _mock_client(fx.THING_763622))
      return ThingiverseImporter()


  @pytest.mark.parametrize("url,expected", [
      ("https://www.thingiverse.com/thing:763622", "763622"),
      ("https://www.thingiverse.com/thing:763622/files", "763622"),
      ("https://example.com/nope", None),
  ])
  def test_canonicalize(url, expected):
      assert ThingiverseImporter().canonicalize(url) == expected

  def test_fetch_metadata_normalizes(imp):
      meta = imp.fetch_metadata(fx.THING_ID)
      assert meta.site is ImportSite.THINGIVERSE and meta.title == "Marvin (keychain)"
      assert meta.author == "makerbot"
      assert meta.license == "CC-BY-4.0"  # mapped from "Creative Commons - Attribution"
      assert meta.cover_url == "https://cdn.thingiverse.com/renders/cover.jpg"
      assert set(meta.tags) == {"keychain", "marvin"}
      assert meta.reject_reason is None

  def test_list_files_from_zip_data(imp):
      files = imp.list_files(fx.THING_ID)
      assert [f.filename for f in files] == ["Marvin.stl", "Marvin_v2.stl"]
      assert files[0].url == "https://cdn.thingiverse.com/assets/aa/marvin.stl"

  def test_resolve_download_adds_bearer(monkeypatch):
      monkeypatch.setattr(thingiverse, "_token", lambda: "tok-xyz")
      out = ThingiverseImporter().resolve_download(
          fx.THING_ID,
          ImportFile(remote_id="Marvin.stl", filename="Marvin.stl",
                     url="https://cdn.thingiverse.com/assets/aa/marvin.stl"),
      )
      assert out.url == "https://cdn.thingiverse.com/assets/aa/marvin.stl"
      assert out.headers == {"Authorization": "Bearer tok-xyz"}
  ```
  Run → GREEN.

- [ ] **Step 7 — live smoke (marked, excluded)** append to `test_thingiverse_importer.py`:
  ```python
  @pytest.mark.live_importer
  def test_live_thingiverse_metadata():
      """Deferred/manual live smoke (SPEC "one live smoke"). Excluded from the
      default gate by the -m in pyproject; run with `-m live_importer` and a
      TDMM_THINGIVERSE_TOKEN in the environment. Never runs in CI."""
      import os

      token = os.environ.get("TDMM_THINGIVERSE_TOKEN")
      if not token:
          pytest.skip("set TDMM_THINGIVERSE_TOKEN to run the live smoke")
      import app.importers.thingiverse as tv

      monkey = pytest.MonkeyPatch()
      monkey.setattr(tv, "_token", lambda: token)
      try:
          meta = tv.ThingiverseImporter().fetch_metadata(fx.THING_ID)
          assert meta.title and meta.external_id == fx.THING_ID
      finally:
          monkey.undo()
  ```
  Register the marker in `pyproject.toml` (Task 7 Step 1 sets the `addopts` exclusion; add the `markers` entry now so `-v` doesn't warn): add to `[tool.pytest.ini_options] markers` the line `"live_importer: live-network importer smoke tests; excluded from the default gate"`. Confirm `uv run pytest tests/test_thingiverse_importer.py -v` collects 7 tests and the live one is deselected/skipped once Task 7's `addopts` lands (until then it skips on the missing token).

- [ ] **Step 8 — run + gates.** Full `uv run pytest` green. Ruff clean + format check clean.

- [ ] **Step 9 — commit.** `git add -A && git commit -m "Add Thingiverse importer, app-token settings storage, and masked token API"`.

**Accept:** the Thingiverse importer parses a recorded `things/{id}` body into normalized metadata (mapped license) + `zip_data.files[]` downloads + `zip_data.images[]` cover, and attaches a Bearer header on `resolve_download`; the token API masks on read, keeps-on-blank, and rejects a bare `"***"` when nothing is stored; the token is never returned or logged; the live smoke is marked and excluded.

---

## Task 5: Printables importer (unofficial GraphQL, anonymous, Club/paid rejected)

SPEC "Gallery importers" Printables row + FULL line 229 (`POST api.printables.com/graphql/`, `print(id:)` + `getDownloadLink`, browser-like UA, "Skip Club/paid with a clear error", "isolate queries in one module, integration-test against model 3161"). Implements the importer with all GraphQL queries **isolated in this one module** and a contract test against a recorded fixture for the SPEC-named model **3161**. Anonymous (no token). Club/paid/premium models set `reject_reason` so the task rejects them **before any download**.

**Files:**
- Create: `backend/app/importers/printables.py`, `backend/tests/cassettes/printables_fixtures.py`, `backend/tests/test_printables_importer.py`
- Modify: `backend/app/importers/registry.py` (register `printables` at the bottom)

**Interfaces:** `@register_importer`-instanced `PrintablesImporter` (`site = ImportSite.PRINTABLES`); module seam `_client() -> httpx.Client`; module constants `PRINT_QUERY`, `DOWNLOAD_MUTATION` (the isolated GraphQL). No auth.

- [ ] **Step 1 — cassette** `backend/tests/cassettes/printables_fixtures.py` — hand-built `print(id:)` + `getDownloadLink` bodies matching the unofficial GraphQL shape, for the SPEC-named model **3161**, plus a premium variant:
  ```python
  """Recorded GraphQL bodies for Printables model 3161 (the SPEC-named contract
  model) matching api.printables.com/graphql/'s print(id:)/getDownloadLink
  shapes. Hand-built (M5 EXCEPTION -- no network in the default gate)."""

  MODEL_ID = "3161"

  PRINT_3161 = {
      "data": {
          "print": {
              "id": 3161,
              "name": "Benchy",
              "description": "The jolly 3D printing torture test.",
              "user": {"publicUsername": "printables_user"},
              "license": {"name": "CC-BY-4.0"},
              "tags": [{"name": "boat"}, {"name": "calibration"}],
              "image": {"filePath": "media/prints/3161/cover.png"},
              "premium": False,
              "stls": [
                  {"id": 90001, "name": "3DBenchy.stl", "fileSize": 2400000},
                  {"id": 90002, "name": "3DBenchy_hollow.stl", "fileSize": 1800000},
              ],
          }
      }
  }

  PRINT_3161_PREMIUM = {
      "data": {
          "print": {
              "id": 3161, "name": "Paid Model",
              "description": "", "user": {"publicUsername": "seller"},
              "license": {"name": "Standard Digital"}, "tags": [],
              "image": None, "premium": True, "stls": [],
          }
      }
  }

  DOWNLOAD_LINK_90001 = {
      "data": {"getDownloadLink": {"ok": True,
               "output": {"link": "https://files.printables.com/media/dl/3161/3DBenchy.stl?token=abc"}}}
  }
  ```

- [ ] **Step 2 — the importer** `app/importers/printables.py`:
  ```python
  """Printables importer over the UNOFFICIAL GraphQL API (SPEC/FULL line 229:
  POST api.printables.com/graphql/, print(id:) + getDownloadLink, browser-like
  UA, anonymous for free models; Club/paid rejected). ALL GraphQL is isolated
  in this one module (the SPEC's contract-test seam) -- ``_client`` is the ONE
  seam tests monkeypatch. A Cloudflare tightening would be handled by a
  cloudscraper fallback hook (documented later escalation, not a v1 dep)."""
  from __future__ import annotations

  import re
  from typing import ClassVar

  import httpx

  from app.importers.base import ImportFile, ImportMetadata, ResolvedDownload, safe_filename
  from app.importers.registry import register_importer
  from app.models.enums import ImportSite

  _GRAPHQL_URL = "https://api.printables.com/graphql/"
  _IMG_BASE = "https://media.printables.com/"
  # Printables URLs: /model/<numericId>-<slug> (the id is the numeric prefix).
  _URL_RE = re.compile(r"printables\.com/(?:[a-z]{2}/)?model/(\d+)", re.IGNORECASE)
  _UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
         "Chrome/125.0 Safari/537.36")

  PRINT_QUERY = """
  query PrintProfile($id: ID!) {
    print(id: $id) {
      id name description
      user { publicUsername }
      license { name }
      tags { name }
      image { filePath }
      premium
      stls { id name fileSize }
    }
  }
  """.strip()

  DOWNLOAD_MUTATION = """
  mutation GetDownloadLink($id: ID!, $fileId: ID!, $fileType: DownloadFileTypeEnum!) {
    getDownloadLink(id: $id, fileId: $fileId, fileType: $fileType) {
      ok output { link }
    }
  }
  """.strip()


  def _client() -> httpx.Client:
      return httpx.Client(
          base_url=_GRAPHQL_URL, timeout=30.0, follow_redirects=True,
          headers={"User-Agent": _UA, "Content-Type": "application/json",
                   "Origin": "https://www.printables.com", "Referer": "https://www.printables.com/"},
      )


  def _post(client: httpx.Client, query: str, variables: dict) -> dict:
      r = client.post("", json={"query": query, "variables": variables})
      r.raise_for_status()
      body = r.json()
      if body.get("errors"):
          raise RuntimeError(f"Printables GraphQL error: {body['errors']}")
      return body["data"]


  class PrintablesImporter:
      site: ClassVar[ImportSite] = ImportSite.PRINTABLES

      def canonicalize(self, url: str) -> str | None:
          m = _URL_RE.search(url)
          return m.group(1) if m else None

      def _print(self, external_id: str) -> dict:
          with _client() as c:
              return _post(c, PRINT_QUERY, {"id": external_id})["print"]

      def fetch_metadata(self, external_id: str) -> ImportMetadata:
          p = self._print(external_id)
          reject = None
          if p.get("premium"):
              reject = "This is a Printables Club / paid model and can't be imported (login required)."
          image = p.get("image") or {}
          cover = f"{_IMG_BASE}{image['filePath']}" if image.get("filePath") else None
          return ImportMetadata(
              site=self.site, external_id=str(external_id),
              source_url=f"https://www.printables.com/model/{external_id}",
              title=p.get("name") or f"print {external_id}",
              description=p.get("description"),
              author=(p.get("user") or {}).get("publicUsername"),
              license=(p.get("license") or {}).get("name"),
              cover_url=cover,
              tags=tuple(t["name"] for t in p.get("tags", []) if t.get("name")),
              reject_reason=reject,
          )

      def list_files(self, external_id: str) -> list[ImportFile]:
          p = self._print(external_id)
          return [
              ImportFile(remote_id=str(s["id"]), filename=safe_filename(s.get("name")),
                         url=None, size=s.get("fileSize"))
              for s in p.get("stls", []) if s.get("id") and s.get("name")
          ]

      def resolve_download(self, external_id: str, file: ImportFile) -> ResolvedDownload:
          with _client() as c:
              data = _post(c, DOWNLOAD_MUTATION,
                           {"id": external_id, "fileId": file.remote_id, "fileType": "STL"})
          out = (data.get("getDownloadLink") or {}).get("output") or {}
          link = out.get("link")
          if not link:
              raise RuntimeError(f"Printables returned no download link for file {file.remote_id}")
          return ResolvedDownload(url=link, filename=file.filename)


  register_importer(PrintablesImporter())
  ```
  At the BOTTOM of `app/importers/registry.py` add: `from app.importers import printables as _printables  # noqa: E402,F401  (registers printables)`.

- [ ] **Step 3 — contract test** `backend/tests/test_printables_importer.py`:
  ```python
  import httpx
  import pytest

  from app.importers import printables
  from app.importers.printables import PrintablesImporter
  from app.models.enums import ImportSite
  from tests.cassettes import printables_fixtures as fx


  def _mock_client(print_body, link_body=None):
      def handler(request: httpx.Request) -> httpx.Response:
          payload = request.read().decode()
          if "getDownloadLink" in payload:
              return httpx.Response(200, json=link_body or fx.DOWNLOAD_LINK_90001)
          return httpx.Response(200, json=print_body)
      return httpx.Client(base_url="https://api.printables.com/graphql/",
                          transport=httpx.MockTransport(handler))


  @pytest.mark.parametrize("url,expected", [
      ("https://www.printables.com/model/3161-benchy", "3161"),
      ("https://www.printables.com/en/model/3161", "3161"),
      ("https://thingiverse.com/thing:1", None),
  ])
  def test_canonicalize(url, expected):
      assert PrintablesImporter().canonicalize(url) == expected

  def test_fetch_metadata_free_model(monkeypatch):
      monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
      meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
      assert meta.site is ImportSite.PRINTABLES and meta.title == "Benchy"
      assert meta.author == "printables_user" and meta.license == "CC-BY-4.0"
      assert set(meta.tags) == {"boat", "calibration"}
      assert meta.cover_url.endswith("media/prints/3161/cover.png")
      assert meta.reject_reason is None

  def test_premium_model_is_rejected_with_clear_message(monkeypatch):
      monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161_PREMIUM))
      meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
      assert meta.reject_reason and "paid" in meta.reject_reason.lower()

  def test_list_files_from_stls(monkeypatch):
      monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
      files = PrintablesImporter().list_files(fx.MODEL_ID)
      assert [f.filename for f in files] == ["3DBenchy.stl", "3DBenchy_hollow.stl"]
      assert files[0].remote_id == "90001"

  def test_resolve_download_returns_cdn_link(monkeypatch):
      monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
      from app.importers.base import ImportFile

      out = PrintablesImporter().resolve_download(
          fx.MODEL_ID, ImportFile(remote_id="90001", filename="3DBenchy.stl"))
      assert out.url.startswith("https://files.printables.com/media/dl/3161/3DBenchy.stl")

  @pytest.mark.live_importer
  def test_live_printables_metadata():
      """Deferred/manual live smoke (SPEC "one live smoke"), excluded from the
      default gate. Run with `-m live_importer`; hits the real GraphQL API."""
      meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
      assert meta.title and meta.external_id == fx.MODEL_ID
  ```
  Run `uv run pytest tests/test_printables_importer.py -v` → GREEN (live one deselected once Task 7's `addopts` lands).

- [ ] **Step 4 — run + gates.** Full `uv run pytest` green. Ruff clean + format check clean.

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add Printables importer (GraphQL, anonymous, Club/paid rejected) with contract test for model 3161"`.

**Accept:** all Printables GraphQL lives in one module; the contract test parses model 3161's recorded `print(id:)` into normalized metadata + `stls[]` files and resolves a `getDownloadLink` CDN URL; a premium/Club model sets `reject_reason` (so the task rejects it before any download); the live smoke is marked and excluded.

---

## Task 6: Import UI (`/import`) + provenance display + Settings site-tokens card + `ModelSummary.source_site`

SPEC "Frontend" `/import` (URL → preview → file checklist → progress) + `/settings` (site tokens) + FULL line 232 (provenance always shown; ToS note shown once for Printables) + controller decision 6 (attribution on the model page AND a gallery badge). Replaces the `/import` `ComingSoonPage` with a real `ImportPage`, adds the token card, the SSE import branch, and provenance rendering. **Scope note (resolved gap):** the controller's endpoint set (POST/GET/list only — no server-side metadata-preview endpoint) means M5 imports the importer's **full** file list rather than offering a pre-import per-file checklist; the `/import` "preview" is the client-side **site-detection** confirmation (site badge + URL), and the MakerWorld URL yields the friendly deferred message. A per-file selection UI + metadata-preview endpoint is a documented later enhancement.

**Files:**
- Create: `web/src/api/imports.ts`, `web/src/lib/importSites.ts`, `web/src/pages/ImportPage.tsx`, `web/src/components/settings/SiteTokensCard.tsx`, `web/src/components/model-detail/ProvenanceBlock.tsx`, `web/src/lib/importSites.test.ts`, `web/src/pages/ImportPage.test.tsx`
- Modify: `web/src/api/types.ts` (import types + `source_site` on `ModelSummary`/`ModelDetail` already has it), `web/src/hooks/useEvents.tsx` (`import_from_url` branch), `web/src/routes.tsx` (swap `/import` → `ImportPage`), `web/src/pages/SettingsPage.tsx` (mount `SiteTokensCard`), `web/src/components/model-detail/ModelHeader.tsx` (render `ProvenanceBlock`), `web/src/components/gallery/ModelCard.tsx` (source badge), and backend `backend/app/schemas/library.py` + `backend/app/services/library.py` (add `source_site` to `ModelSummary`) + `backend/tests/test_models_api.py` (assert it)

- [ ] **Step 1 — backend: `source_site` on `ModelSummary`.** In `app/schemas/library.py` `ModelSummary`, add `source_site: str | None = None` (after `has_sliced`). In `app/services/library.py` `list_models`' `ModelSummary(...)` construction, add `source_site=m.source_site,`. Add an assertion to an existing gallery test (`backend/tests/test_models_api.py`): after creating an imported model via `create_imported_model_sync` (or a manual model, `source_site` None), `GET /api/models` items carry `source_site`. Run `uv run pytest tests/test_models_api.py -v` → GREEN. (This is the one backend change in this task; commit it with the rest.)

- [ ] **Step 2 — TS types.** In `web/src/api/types.ts`: add `source_site: string | null` to `ModelSummary` (after `has_sliced`). Append an imports section:
  ```ts
  // -- imports (backend/app/schemas/imports.py, app/models/enums.py) --
  export type ImportSite = "thingiverse" | "printables" | "makerworld";
  export type ImportState = "pending" | "fetching" | "downloading" | "done" | "failed";
  export interface ImportOut {
    id: number; url: string; site: ImportSite; external_id: string | null;
    state: ImportState; model_id: number | null; error: string | null;
    meta: Record<string, unknown> | null; created_at: string; updated_at: string;
  }
  export interface ImportCreate { url: string; }
  export interface ImportTokensIn { thingiverse_token: string; }
  export interface ImportTokensOut { thingiverse_token: string; }  // "***" when set, "" otherwise
  // -- events union: add import_from_url handling on the existing job.updated shape --
  ```
  (No new event interface — imports reuse `JobUpdatedEvent`; only the handler gains a branch.)

- [ ] **Step 3 — site detection util** `web/src/lib/importSites.ts`:
  ```ts
  import type { ImportSite } from "@/api/types";

  export interface DetectedSite {
    site: ImportSite | null;
    label: string;
    supported: boolean;   // false for makerworld (deferred) and null (unknown)
  }

  const HOSTS: Record<string, { site: ImportSite; label: string; supported: boolean }> = {
    "thingiverse.com": { site: "thingiverse", label: "Thingiverse", supported: true },
    "printables.com": { site: "printables", label: "Printables", supported: true },
    "makerworld.com": { site: "makerworld", label: "MakerWorld", supported: false },
  };

  /** Client-side site detection for the /import preview. A MakerWorld URL is
   * recognized (so we can show a friendly "not available yet") but not
   * supported; anything else is unknown. Mirrors the backend's registry. */
  export function detectSite(rawUrl: string): DetectedSite {
    let host = "";
    try {
      host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return { site: null, label: "", supported: false };
    }
    const hit = HOSTS[host];
    return hit ? { ...hit } : { site: null, label: "", supported: false };
  }
  ```
  `web/src/lib/importSites.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { detectSite } from "@/lib/importSites";

  describe("detectSite", () => {
    it("detects thingiverse + printables as supported", () => {
      expect(detectSite("https://www.thingiverse.com/thing:763622")).toMatchObject({ site: "thingiverse", supported: true });
      expect(detectSite("https://printables.com/model/3161-benchy")).toMatchObject({ site: "printables", supported: true });
    });
    it("detects makerworld as recognized-but-unsupported", () => {
      expect(detectSite("https://makerworld.com/en/models/1")).toMatchObject({ site: "makerworld", supported: false });
    });
    it("returns null for unknown or invalid", () => {
      expect(detectSite("https://example.com/x").site).toBeNull();
      expect(detectSite("not a url").site).toBeNull();
    });
  });
  ```

- [ ] **Step 4 — import hooks** `web/src/api/imports.ts`:
  ```ts
  import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

  import { api } from "@/api/client";
  import type { ImportCreate, ImportOut, ImportTokensIn, ImportTokensOut } from "@/api/types";

  const ACTIVE: ReadonlyArray<ImportOut["state"]> = ["pending", "fetching", "downloading"];

  export function useCreateImport() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: ImportCreate) => api.post<ImportOut>("/imports", body),
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["imports"] }),
    });
  }

  /** Polls a single import until it reaches a terminal state, then stops. */
  export function useImport(id: number | undefined) {
    return useQuery({
      queryKey: ["imports", id] as const,
      queryFn: () => api.get<ImportOut>(`/imports/${id}`),
      enabled: id !== undefined,
      refetchInterval: (q) => (ACTIVE.includes(q.state.data?.state ?? "done") ? 1500 : false),
    });
  }

  export const importTokensQueryOptions = queryOptions({
    queryKey: ["settings", "import-tokens"] as const,
    queryFn: () => api.get<ImportTokensOut>("/settings/import-tokens"),
  });
  export function useImportTokens() {
    return useQuery(importTokensQueryOptions);
  }
  export function useUpdateImportTokens() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: ImportTokensIn) => api.put<ImportTokensOut>("/settings/import-tokens", body),
      onSuccess: (data) => qc.setQueryData(importTokensQueryOptions.queryKey, data),
    });
  }
  ```

- [ ] **Step 5 — SSE import branch.** In `web/src/hooks/useEvents.tsx`, inside `source.onmessage`, after the existing `scan_library` branch and before the listener fan-out, add:
  ```tsx
      // Gallery imports reuse the job.updated shape (M5; no new SSE type) with
      // job_type: "import_from_url" -- refresh the import poll + the gallery so
      // a finished import's model appears without a manual reload.
      if (parsed.job_type === "import_from_url") {
        void queryClient.invalidateQueries({ queryKey: ["imports"] });
        void queryClient.invalidateQueries({ queryKey: ["models"] });
      }
  ```

- [ ] **Step 6 — the Import page** `web/src/pages/ImportPage.tsx`:
  ```tsx
  import { useMemo, useState } from "react";
  import { Link } from "@tanstack/react-router";

  import { ApiError } from "@/api/client";
  import { useCreateImport, useImport } from "@/api/imports";
  import { detectSite } from "@/lib/importSites";
  import { Badge } from "@/components/ui/badge";
  import { Button } from "@/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
  import { Input } from "@/components/ui/input";
  import { Label } from "@/components/ui/label";

  const TERMINAL = new Set(["done", "failed"]);

  export function ImportPage() {
    const [url, setUrl] = useState("");
    const [activeId, setActiveId] = useState<number | undefined>(undefined);
    const createImport = useCreateImport();
    const active = useImport(activeId);

    const detected = useMemo(() => detectSite(url), [url]);
    const canImport = detected.supported && !createImport.isPending;

    function start() {
      createImport.mutate(
        { url: url.trim() },
        { onSuccess: (imp) => setActiveId(imp.id) },
      );
    }

    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Import from a gallery</h1>
          <p className="text-sm text-muted-foreground">
            Paste a Thingiverse or Printables model link. Files download into a new model with
            attribution. By importing you confirm the model&apos;s license permits it (personal use,
            one model per action).
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Model URL</CardTitle>
            <CardDescription>The site is detected automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-url">URL</Label>
              <Input
                id="import-url"
                value={url}
                placeholder="https://www.printables.com/model/3161-benchy"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            {url.trim() !== "" && detected.site !== null && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Detected:</span>
                <Badge variant={detected.supported ? "secondary" : "outline"}>{detected.label}</Badge>
              </div>
            )}

            {url.trim() !== "" && detected.site === "makerworld" && (
              <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
                MakerWorld import isn&apos;t available yet. Thingiverse and Printables are supported today.
              </p>
            )}
            {url.trim() !== "" && detected.site === null && (
              <p role="alert" className="text-sm text-destructive">
                Unrecognized link — paste a Thingiverse or Printables model URL.
              </p>
            )}

            <Button type="button" onClick={start} disabled={!canImport}>
              {createImport.isPending ? "Starting…" : "Import"}
            </Button>

            {createImport.isError && (
              <p role="alert" className="text-sm text-destructive">
                {createImport.error instanceof ApiError ? createImport.error.detail : "Could not start the import."}
              </p>
            )}
          </CardContent>
        </Card>

        {active.data && <ImportProgress importId={active.data.id} />}
      </div>
    );
  }

  function ImportProgress({ importId }: { importId: number }) {
    const imp = useImport(importId);
    if (!imp.data) return null;
    const { state, error, model_id } = imp.data;
    const done = TERMINAL.has(state);

    return (
      <Card>
        <CardHeader>
          <CardTitle>Import progress</CardTitle>
          <CardDescription>
            {state === "done" ? "Complete." : done ? "Failed." : `${state}…`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!done && (
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full w-1/2 animate-pulse rounded bg-primary" />
            </div>
          )}
          {state === "failed" && (
            <p role="alert" className="text-sm text-destructive">{error ?? "Import failed."}</p>
          )}
          {state === "done" && model_id !== null && (
            <Button asChild variant="outline">
              <Link to="/">View library</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }
  ```
  (The "View library" link keeps M5 simple — the gallery refreshes via the SSE branch; a deep link to `/models/$slug` would need the slug in `ImportOut`, a later nicety.)

- [ ] **Step 7 — site tokens card** `web/src/components/settings/SiteTokensCard.tsx` (mirrors `PrinterSetupCard`'s masked-secret UX):
  ```tsx
  import { useState } from "react";

  import { ApiError } from "@/api/client";
  import { useImportTokens, useUpdateImportTokens } from "@/api/imports";
  import { Button } from "@/components/ui/button";
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
  import { Input } from "@/components/ui/input";
  import { Label } from "@/components/ui/label";
  import { Skeleton } from "@/components/ui/skeleton";

  export function SiteTokensCard() {
    const tokens = useImportTokens();
    const update = useUpdateImportTokens();
    const [token, setToken] = useState("");

    if (tokens.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
    const isSet = tokens.data?.thingiverse_token === "***";

    return (
      <Card>
        <CardHeader>
          <CardTitle>Gallery site tokens</CardTitle>
          <CardDescription>
            Thingiverse needs a personal App Token to download files. Create a &quot;Desktop app&quot; at
            thingiverse.com/apps/create and paste the token here. Printables needs no token.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="thingiverse-token">Thingiverse App Token</Label>
            <Input
              id="thingiverse-token"
              type="password"
              autoComplete="new-password"
              value={token}
              placeholder={isSet ? "•• (stored — leave blank to keep)" : "paste your app token"}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <Button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ thingiverse_token: token }, { onSuccess: () => setToken("") })}
          >
            {update.isPending ? "Saving…" : "Save token"}
          </Button>
          {update.isError && (
            <p role="alert" className="text-sm text-destructive">
              {update.error instanceof ApiError ? update.error.detail : "Could not save the token."}
            </p>
          )}
          {update.isSuccess && <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>}
        </CardContent>
      </Card>
    );
  }
  ```
  In `web/src/pages/SettingsPage.tsx`: import `SiteTokensCard` and render it after `PrinterSetupCard` (inside the `<>` block).

- [ ] **Step 8 — provenance block** `web/src/components/model-detail/ProvenanceBlock.tsx`:
  ```tsx
  import { ExternalLinkIcon } from "lucide-react";

  import { Badge } from "@/components/ui/badge";
  import type { ModelDetail } from "@/api/types";

  const SITE_LABELS: Record<string, string> = {
    thingiverse: "Thingiverse", printables: "Printables", makerworld: "MakerWorld",
  };

  /** Attribution for an imported model (FULL line 232: provenance always shown
   * — CC attribution requires it). Renders nothing for a manually-created model. */
  export function ProvenanceBlock({ model }: { model: ModelDetail }) {
    if (!model.source_url && !model.source_site && !model.source_author) return null;
    const label = model.source_site ? (SITE_LABELS[model.source_site] ?? model.source_site) : "source";
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="provenance">
        <span>Imported from</span>
        {model.source_url ? (
          <a href={model.source_url} target="_blank" rel="noreferrer"
             className="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
            {label}<ExternalLinkIcon className="size-3.5" />
          </a>
        ) : (
          <span className="font-medium text-foreground">{label}</span>
        )}
        {model.source_author && <span>by {model.source_author}</span>}
        {model.source_license && <Badge variant="outline">{model.source_license}</Badge>}
      </div>
    );
  }
  ```
  In `web/src/components/model-detail/ModelHeader.tsx`, import `ProvenanceBlock` and render `<ProvenanceBlock model={model} />` just below the `<TagEditor model={model} />` line (still inside the header container).

- [ ] **Step 9 — gallery source badge.** In `web/src/components/gallery/ModelCard.tsx`, add a small badge when `model.source_site` is set. Inside the `<CardContent>`, next to the format badges block, add:
  ```tsx
          {model.source_site && (
            <Badge variant="outline" className="w-fit capitalize" data-testid="source-badge">
              {model.source_site}
            </Badge>
          )}
  ```

- [ ] **Step 10 — swap the route.** In `web/src/routes.tsx`: replace the `ComingSoonPage`-based `importRoute` component with `ImportPage` — add `import { ImportPage } from "@/pages/ImportPage";` and change `component: () => <ComingSoonPage title="Import" />` to `component: ImportPage`. (Leave the `/import` nav entry in `AppShell` unchanged — it is always visible; MakerWorld gating is page-level, not nav-level.)

- [ ] **Step 11 — page test** `web/src/pages/ImportPage.test.tsx` — a focused render test of the MakerWorld gate + the import button enable/disable (mirror the existing `PrinterSetupCard`/`AppShell` test setup: wrap in a `QueryClientProvider`; assert the MakerWorld message shows for a makerworld URL and the Import button is disabled, and is enabled for a printables URL). Keep it to 2–3 assertions using `@testing-library/react` + `userEvent`, matching the repo's existing `*.test.tsx` conventions.

- [ ] **Step 12 — run + gates.** `npm run build` (tsc strict) green, `npm run lint` clean, `npm test` green. Backend `uv run pytest tests/test_models_api.py -v` green (the `source_site` addition); full `uv run pytest` + ruff still clean.

- [ ] **Step 13 — commit.** `git add -A && git commit -m "Add /import page, site-tokens card, provenance display, gallery source badge, and SSE import branch"`.

**Accept:** `/import` detects the site client-side, imports Thingiverse/Printables URLs, shows live progress, and shows the friendly "not available yet" for a MakerWorld URL; Settings has a masked Thingiverse-token card; the model page shows a provenance block (source link + author + license) for imported models and nothing for manual ones; the gallery card shows a source badge; imports refresh the gallery live via the SSE branch.

---

## Task 7: Full offline flow test + `live_importer` gate carve-out + README docs

SPEC "Verification" ("contract tests against recorded fixtures + one live smoke") + FULL line 232 (ToS note shown once for Printables) + the SPEC M5 *Accept* "within a minute" flow. Finalizes the test-gate carve-out for the live smokes, adds the full-stack offline flow test that proves "create-import → poll → model with files appears," and documents importer setup + the ToS posture.

**Resolved spec-coverage gap (reported to the controller):** the controller named `backend/tests_e2e/test_m5_importers.py`, but the `tests_e2e/` suite runs `httpx`-against-a-live-`docker compose` stack and imports NO `app.*`, so it cannot inject `httpx.MockTransport` into the running container — and hitting real Thingiverse/Printables from CI is exactly what the M5 carve-out forbids. So the "e2e" full-flow test lives in the **default gate** as `backend/tests/test_m5_import_e2e.py` (real Postgres + Redis + Celery-eager + the real ingest/glb/thumb pipeline in-process; the ONLY mocked edge is the importer HTTP, via the fake importer + `MockTransport`). The live-stack analog is the `@pytest.mark.live_importer` smokes (Tasks 4/5) — deferred/manual, like M4's live-A1 acceptance. **No `tests_e2e/` module is added for M5.**

**Files:**
- Create: `backend/tests/test_m5_import_e2e.py`
- Modify: `backend/pyproject.toml` (finalize `addopts` + `markers`), `README.md` (new "Gallery importers" section)

- [ ] **Step 1 — finalize the gate carve-out.** In `backend/pyproject.toml`:
  - Change `addopts = "-m 'not e2e'"` to `addopts = "-m 'not e2e and not live_importer'"`.
  - Ensure the `markers` list contains BOTH the existing `e2e` marker AND (added in Task 4 Step 7) `"live_importer: live-network importer smoke tests (real Thingiverse/Printables); excluded from the default gate by the -m in addopts"`.
  - Update the `addopts` explanatory comment to note that `live_importer` (like `e2e`) keeps the default `uv run pytest` off the network, and that `scripts/e2e.sh`'s explicit `-m e2e` still overrides it for the live-stack run.
  Verify: `uv run pytest -m live_importer --collect-only -q` lists exactly the two live smokes; `uv run pytest --collect-only -q | grep -c live_importer` under the default `addopts` shows they are deselected.

- [ ] **Step 2 — full offline flow test** `backend/tests/test_m5_import_e2e.py`:
  ```python
  """M5 full-stack offline flow (create-import -> poll -> model with files
  appears). Real Postgres + Redis + Celery-eager + the real ingest/glb/thumb
  pipeline run in-process; the ONLY mocked edge is the importer HTTP (fake
  importer + httpx.MockTransport, via the `fake_import` fixture). This is the
  offline analog of an e2e -- see the Task 7 gap note. NO real network."""
  import pytest

  from app.models.enums import ImportState
  from app.models.system import Import
  from app.tasks.base import sync_session
  from tests import corpus


  @pytest.mark.asyncio
  async def test_import_produces_a_browsable_model_with_files(
      authenticated_client, library_root, data_dir, fake_import
  ):
      fake_import.title = "Imported Benchy"
      fake_import.author = "captain"
      fake_import.license = "CC-BY-4.0"
      fake_import.tags = ("boat", "calibration")
      fake_import.files = {"benchy.stl": corpus.box_stl(), "hollow.stl": corpus.box_obj()}

      created = await authenticated_client.post(
          "/api/imports", json={"url": "https://fake.test/thing/42"}
      )
      assert created.status_code == 201, created.text
      imp = created.json()
      assert imp["state"] == "done" and imp["model_id"] is not None  # eager => terminal

      # the import row records provenance meta (cover + selected files)
      assert imp["meta"]["files"] == ["benchy.stl", "hollow.stl"]

      # the model is in the gallery with attribution
      gallery = (await authenticated_client.get("/api/models")).json()["items"]
      row = next(m for m in gallery if m["name"] == "Imported Benchy")
      assert row["source_site"] == "thingiverse"

      # the model detail carries full provenance + a rev-001_imported revision
      # with both files (verified by the real store_to_backend pipeline)
      slug = row["slug"]
      detail = (await authenticated_client.get(f"/api/models/{slug}")).json()
      assert detail["source_author"] == "captain" and detail["source_license"] == "CC-BY-4.0"
      assert detail["source_url"] == "https://fake.test/thing/42"
      rev = detail["current_revision"]
      assert rev["dir_name"] == "rev-001_imported"
      assert sorted(f["rel_path"] for f in rev["files"]) == ["benchy.stl", "hollow.stl"]

      # the imports table has exactly one row and it points at the model
      with sync_session() as s:
          rows = s.query(Import).all()
          assert len(rows) == 1 and rows[0].state == ImportState.DONE
          assert rows[0].model_id == detail["id"]
  ```
  Run `uv run pytest tests/test_m5_import_e2e.py -v` → GREEN. (If the gallery `GET /api/models/{slug}` file list is momentarily empty because the eager pipeline hasn't flushed `verified_at`, note that `store_imported_file_sync` commits the `File` row before dispatching the store job — the row is present immediately; `verified_at` fills in during the eager `store_to_backend` run, which completes inline before the POST returns.)

- [ ] **Step 3 — README "Gallery importers" section.** Add a section to `README.md` documenting (cite SPEC "Gallery importers" + FULL line 232):
  - **What it does.** Paste a **Thingiverse** or **Printables** model URL on `/import`; the app detects the site, downloads every file into a new library model with full attribution (source link, author, license, tags), and runs it through the normal ingest pipeline (lands as `rev-001_imported`). Imports are **atomic** — a failed or paid/Club model creates no model.
  - **Thingiverse token setup.** Thingiverse requires a personal **App Token** to download files: go to `thingiverse.com/apps/create`, register a **"Desktop app"**, copy the **App Token**, and paste it in **Settings → Gallery site tokens**. The token is stored masked and never shown again (blank the field to keep the stored one). Printables needs **no token** (free models only; **Club/paid models are rejected with a clear message** — they require a Printables login).
  - **MakerWorld — not yet.** MakerWorld import is **deferred to a later milestone** (it needs a Bambu-account login). Pasting a MakerWorld URL shows a friendly "not available yet" message rather than failing.
  - **ToS / personal use (shown once in the UI, per design).** These importers are for **personal use, one model per action**; by importing you confirm the model's license permits it. The `/import` page header carries this note. Respect each site's Terms of Service and the model's license (imported CC attribution is preserved on the model page).
  - **Reliability.** The Thingiverse API is historically flaky and the Printables GraphQL schema is unofficial; both are isolated behind one module each with recorded-fixture contract tests, and a failed import never corrupts library state.

- [ ] **Step 4 — run + gates.** Full `uv run pytest` green with pristine output; `uv run pytest -m live_importer --collect-only` lists the two smokes; ruff clean + format check clean. Web gates still green (no web change in this task). Re-run the whole backend suite once more to confirm the default gate makes zero network calls (the two live smokes are deselected).

- [ ] **Step 5 — commit.** `git add -A && git commit -m "Add offline import flow test, live_importer gate carve-out, and gallery-importer docs"`.

**Accept:** the default `uv run pytest` excludes the live smokes and makes zero real network calls; the offline flow test proves an import yields a browsable model with `rev-001_imported`, both files, and full provenance; the README documents Thingiverse-token setup, the Printables Club/paid rejection, the MakerWorld deferral, and the personal-use/ToS posture.

---

## Self-Review

**1. Spec coverage.** Every M5 *Accept* clause (SPEC line 179; FULL 311–313) maps to a task:
- **"Printables URL → complete model in library within a minute; with files, license, author, tags, cover"** → T5 (importer parses model 3161: name/author/license/tags/cover + `stls[]` + `getDownloadLink`), T3 (orchestration downloads all → creates model+revision+dispatches store jobs; `meta.cover_url`), T2 (`create_imported_model_sync` writes provenance + tags), T6 (UI), T7 (offline flow test asserts model+files+provenance).
- **"Thingiverse thing imports via `zip_data`"** → T4 (`GET /things/{id}`, `zip_data.files[]/images[]`, Bearer token, manual license map) + T3 orchestration.
- **"paid/Club/exclusive rejected with a clear message"** → T5 (`fetch_metadata` sets `reject_reason` on `premium`) + T3 (task raises `ImportRejected` BEFORE the download phase; row → `failed`, no model) — the CRITICAL invariant "PAID/CLUB/EXCLUSIVE REJECTED BEFORE ANY DOWNLOAD" is enforced by ordering and tested in T3 + T5.
- **"every import shows attribution"** → T6 (`ProvenanceBlock` on the model page + gallery `source_site` badge), backed by T2/T3 writing the 5 provenance columns and T4/T5 supplying author/license/site.
- **"MakerWorld free model with connected account"** → **DEFERRED** (documented in the intro + README); the architecture stays MakerWorld-ready (registry keyed by `ImportSite`) and a MakerWorld URL yields a friendly "not available yet" (T3 backend `422` + T6 client-side gate) — the invariant "A MAKERWORLD URL NEVER CRASHES" is tested in T1 (`deferred_site_for_url`), T3 (API 422), T6 (`detectSite`).
- **SPEC "Gallery importers" `SiteImporter` protocol (`canonicalize`/`fetch_metadata`/`list_files`/`resolve_download`), stream-to-spool → `rev-001_imported`, provenance always stored** → T1 (Protocol + dataclasses + registry), T2 (`rev-001_imported` + stream-to-spool + provenance write), T3 (orchestration reusing the `store_to_backend` pipeline).
- **SPEC "API surface" `imports (create/poll)`** → T3 (`POST`/`GET/{id}`/list). **SPEC "Frontend" `/import` + `/settings` site tokens** → T6. **SPEC "Verification" recorded-fixture contract tests + one live smoke** → T4/T5 (cassette contract tests) + T4/T5/T7 (marked `live_importer` smokes, excluded).
- The five CRITICAL invariants (imports atomic; paid rejected pre-download; token never returned/logged; MakerWorld never crashes; default gate zero network) are each enforced AND tested in a named task (T3, T3/T5, T4, T1/T3/T6, T7).
- **Consciously trimmed vs the fuller UX (reported gap):** FULL line 275's "file checklist" (per-file selection before import) is NOT built — the controller's resolved endpoint set has no metadata-preview endpoint and decision 3 downloads the importer's full file list atomically; the `/import` "preview" is client-side site detection. Documented in T6's scope note. Also the `tests_e2e/` live-docker module is intentionally omitted (T7 gap note) since importer HTTP can't be mocked inside the running container.

**2. Placeholder scan.** No "TBD"/"add error handling"/"similar to Task N"/"write tests for the above" — every code step carries complete, runnable code; every test step names concrete assertions (exact states, exact filenames, exact status codes, exact masked sentinels, exact `rev-001_imported` dir name). The one illustrative-code slip (a stray `revision = ...` line) was removed from Task 3. GraphQL/REST response shapes are pinned in named cassette modules, not left vague. The only "adjust if the installed version differs" latitude is the documented `httpx` version record (T2) — a version note, not a placeholder.

**3. Type consistency.** The FROZEN interfaces defined in T1 are consumed verbatim downstream: `ImportMetadata`/`ImportFile`/`ResolvedDownload`/`SiteImporter` (T1) are produced by `FakeImporter` (T1), `ThingiverseImporter` (T4), `PrintablesImporter` (T5) and consumed by `import_from_url` (T3). `ImportFile.url` (added in T1) carries the download URL from `list_files` to `resolve_download` in every importer. `StagedFile` (T2, `app.importers.download`) is produced by `stream_remote_to_spool` (T2) and consumed by `store_imported_file_sync` (T2) and `import_from_url` (T3) with the same field names (`token`/`spool_path`/`blob_hash`/`size`/`rel_path`/`kind`/`format_`). `create_imported_model_sync`/`store_imported_file_sync` (T2) are called with the exact kwargs T3 passes. `build_importer_for_url`/`deferred_site_for_url`/`IMPORTER_REGISTRY`/`register_importer` (T1) are used by T3 (API), T4/T5 (registration). `publish_import_event_sync(redis_url, import_id, state)` (T3) matches the `job.updated` shape the frontend `useEvents` branch keys on (`job_type === "import_from_url"`, T6). `ImportOut`/`ImportCreate` (T3 schema) are mirrored field-for-field by `web/src/api/types.ts` (T6). `ImportTokens`/`get_import_tokens_sync` (T4 service) is read by the Thingiverse `_token()` (T4); `ImportTokensIn`/`ImportTokensOut` (T4 schema) mirror the TS types (T6). `ModelSummary.source_site` (T6 backend) matches the TS `ModelSummary.source_site` (T6). The `_client`/`_download_client` monkeypatch seams (T2/T4/T5) are the single construction point every test overrides.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-m5-importers.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, controller diff-skims between tasks (per the ledger's reduced-review policy), with one whole-branch review + fix wave at milestone end (the security-sensitive surfaces to weight in that review: the token mask/merge path in T4 and the download-all-then-create atomicity + failure cleanup in T3). Fast iteration; each task's RED/GREEN evidence captured in its report.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
