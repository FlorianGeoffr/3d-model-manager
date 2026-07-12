/**
 * Payload types for the `/api` backend, hand-mirrored from
 * `backend/app/schemas/*.py` (source of truth — keep in sync by hand, no
 * codegen per Task 8 decisions).
 */

// -- enums (backend/app/models/enums.py) -----------------------------------

export const BLOB_FORMATS = [
  "stl",
  "3mf",
  "obj",
  "step",
  "iges",
  "gcode_3mf",
  "gcode",
  "png",
  "jpg",
  "other",
] as const;

export type BlobFormat = (typeof BLOB_FORMATS)[number];

export type BlobKind = "mesh" | "cad" | "sliced" | "gcode" | "image" | "other";

// -- models (backend/app/schemas/library.py) -------------------------------

export interface ModelCreate {
  name: string;
  description?: string | null;
}

export interface ModelPatch {
  name?: string;
  description?: string | null;
  cover_blob_hash?: string | null;
  review_state?: string | null;
  favorite?: boolean;
}

// `POST /models/bulk` (Branch 4 Task 1): apply the same tag/favorite changes
// to every model in `ids` in one call.
export interface ModelBulkIn {
  ids: number[];
  add_tags?: string[];
  remove_tags?: string[];
  favorite?: boolean;
}

export interface ModelBulkOut {
  updated: number;
}

// Multi-backend storage (backend/app/schemas/library.py, Workstream C task
// C3/C4) -- `POST /models/{slug}/relocate` moves or replicates every file of
// a model onto another configured backend.
export interface ModelRelocateIn {
  target_backend_id: number;
  mode: "move" | "replicate";
}

// The DISTINCT storage backends holding a model's current-revision files
// (`files.backend_id`, PRIMARY location only -- see
// `app.services.library._model_backends_summary`).
export interface ModelBackendOut {
  id: number;
  name: string;
}

export interface ModelSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  tags: string[];
  updated_at: string;
  created_at: string;
  file_count: number;
  formats: BlobFormat[];
  cover: string | null;
  print_time_s: number | null;
  has_sliced: boolean;
  source_site: string | null;
  review_state?: string | null;
  source_collection_id: number | null;
  source_collection_title: string | null;
  favorite: boolean;
}

export interface GalleryPage {
  items: ModelSummary[];
  next_cursor: string | null;
}

// -- blob metadata / plates (backend/app/schemas/library.py, Task 7) -------

export interface PlateFilamentOut {
  type: string | null;
  color: string | null;
  used_m: number | null;
  used_g: number | null;
}

export interface PlateOut {
  index: number;
  prediction_s: number | null;
  weight_g: number | null;
  thumbnail_available: boolean;
  filaments: PlateFilamentOut[];
}

export interface BlobMetaOut {
  triangle_count: number | null;
  dims_mm: number[] | null;
  volume_cm3: number | null;
  surface_area_cm2: number | null;
  is_watertight: boolean | null;
  print_time_s: number | null;
  filament_g: number | null;
  filament_m: number | null;
  filament_types: string[] | null;
  layer_height: number | null;
  nozzle: number | null;
  printer_model: string | null;
  plate_count: number | null;
  plates: PlateOut[] | null;
}

// `null` means the blob's format never produces a GLB at all, distinct from
// a GLB-format blob that simply hasn't been converted yet ("pending").
export type GlbStatus = "ok" | "pending" | "failed" | "unsupported";

// -- files / notes ----------------------------------------------------------

export interface FileOut {
  id: number;
  revision_id: number;
  rel_path: string;
  storage_path: string;
  blob_hash: string;
  size: number;
  format: BlobFormat;
  kind: BlobKind;
  mtime: string | null;
  verified_at: string | null;
  meta: BlobMetaOut | null;
  thumb_ready: boolean;
  glb_status: GlbStatus | null;
  glb_preview_ready: boolean;
}

export interface NoteCreate {
  model_id: number;
  revision_id?: number | null;
  body: string;
}

export interface NotePatch {
  body: string;
}

export interface NoteOut {
  id: number;
  model_id: number;
  revision_id: number | null;
  body: string;
  created_at: string;
  updated_at: string;
}

// -- revisions ----------------------------------------------------------

export interface RevisionCreate {
  name?: string | null;
  note?: string | null;
}

export interface RevisionSummary {
  id: number;
  model_id: number;
  number: number;
  name: string | null;
  note: string | null;
  dir_name: string;
  created_at: string;
  file_count: number;
}

export interface RevisionDetail {
  id: number;
  model_id: number;
  number: number;
  name: string | null;
  note: string | null;
  dir_name: string;
  created_at: string;
  files: FileOut[];
  notes: NoteOut[];
}

export interface ModelDetail {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  source_url: string | null;
  source_site: string | null;
  source_author: string | null;
  source_license: string | null;
  source_collection_id: number | null;
  source_collection_title: string | null;
  imported_at: string | null;
  cover_blob_hash: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  tags: string[];
  current_revision: RevisionDetail | null;
  notes: NoteOut[];
  review_state?: string | null;
  backends: ModelBackendOut[];
  favorite: boolean;
  // Branch 5 Task 1 print-history aggregates -- zero-state is
  // `print_count: 0, last_printed_at: null` for a model with no logged prints.
  print_count: number;
  last_printed_at: string | null;
}

// -- diff ----------------------------------------------------------

export interface DiffEntrySide {
  blob_hash: string;
  size: number;
}

export interface DiffEntry {
  rel_path: string;
  a: DiffEntrySide | null;
  b: DiffEntrySide | null;
}

export interface DiffResponse {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  unchanged: DiffEntry[];
}

// -- tags ----------------------------------------------------------

export interface TagCreate {
  name: string;
}

export interface TagOut {
  id: number;
  name: string;
}

// -- uploads (backend/app/schemas/uploads.py) --------------------------------

export interface UploadResult {
  file_id: number;
  blob_hash: string;
  size: number;
  job_id: string;
}

// -- jobs (backend/app/schemas/jobs.py) --------------------------------

// `dead` (Task 8): a formal dead-letter state, auto-parked once a job has
// exhausted its `max_attempts` ceiling -- distinct from a plain `failed`
// that's still worth retrying automatically.
export type JobState = "queued" | "running" | "done" | "failed" | "dead";

export interface JobOut {
  id: string;
  celery_id: string | null;
  type: string;
  subject_type: string | null;
  subject_id: number | null;
  state: JobState;
  attempts: number;
  max_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// -- settings / storage config (backend/app/schemas/settings.py, Task 7) --

export type StorageScheme = "local" | "smb" | "s3";

export interface StorageConfigOut {
  backend: StorageScheme;
  config: Record<string, unknown>;
}

export interface StorageConfigIn {
  backend: StorageScheme;
  config: Record<string, unknown>;
}

export interface ConnectionTestOut {
  ok: boolean;
  detail: string;
  latency_ms: number;
}

// -- multi-backend storage CRUD (backend/app/schemas/settings.py, Workstream
// C task C3) -- unlike `StorageConfigIn`/`StorageConfigOut` above (the
// legacy single-backend shim), these operate on a specific
// `storage_backends` row; `config` carries its own `backend` discriminator
// field inside it (same shape `StorageConfigOut.config` already uses since
// both come from the same `redacted()` call server-side).

export interface StorageBackendOut {
  id: number;
  name: string;
  scheme: StorageScheme;
  is_default: boolean;
  config: Record<string, unknown>;
  created_at: string;
}

export interface StorageBackendCreateIn {
  name: string;
  config: Record<string, unknown>;
}

export interface StorageBackendUpdateIn {
  name?: string;
  config?: Record<string, unknown>;
}

// -- scan (backend/app/schemas/scan.py, Task 8) ----------------------------

export type ScanState = "queued" | "running" | "done" | "failed" | "skipped";

export interface ScanAdopted {
  model_id: number;
  slug: string;
  revision_id: number;
  files: string[];
}

export interface ScanRelinked {
  file_id: number;
  from: string;
  to: string;
  hash: string;
}

export interface ScanChanged {
  file_id: number;
  storage_path: string;
  old_hash: string;
  new_hash: string;
}

export interface ScanMissing {
  file_id: number;
  storage_path: string;
  model_slug: string;
}

// Added in Task 5's fix wave alongside `verified` -- both must be mirrored
// here even though the earlier Task 5/6 interface note predates them.
export interface ScanError {
  storage_path: string;
  error: string;
}

export interface ScanReport {
  adopted: ScanAdopted[];
  relinked: ScanRelinked[];
  changed: ScanChanged[];
  missing: ScanMissing[];
  errors: ScanError[];
  verified: number;
}

export interface ScanRunOut {
  id: number;
  created_at: string;
  finished_at: string | null;
  state: ScanState;
  files_seen: number;
  files_hashed: number;
  relinked: number;
  adopted: number;
  missing: number;
  report: ScanReport | null;
}

// -- events (SSE, Global Constraints) --------------------------------

export interface JobUpdatedEvent {
  type: "job.updated";
  job_id: string;
  job_type: string;
  state: JobState;
  subject_type: string | null;
  subject_id: number | null;
}

// -- printers/features/events union (backend/app/schemas/printers.py,
// backend/app/api/features.py; M4 Task 8) ----------------------------------

export interface Features {
  printer_enabled: boolean;
}

export type PrinterKind = "bambu_lan";

export interface PrinterOut {
  id: number;
  name: string;
  kind: PrinterKind;
  host: string;
  serial: string;
  model: string | null;
  enabled: boolean;
  options: Record<string, unknown>;
  access_code_set: boolean;
}

export interface PrinterCreate {
  name: string;
  kind?: PrinterKind;
  host: string;
  serial: string;
  access_code: string;
  model?: string | null;
  enabled?: boolean;
  options?: Record<string, unknown>;
}

export interface PrinterUpdate {
  name?: string;
  host?: string;
  serial?: string;
  access_code?: string;
  model?: string | null;
  enabled?: boolean;
  options?: Record<string, unknown>;
}

export interface ProbeOut {
  ok: boolean;
  detail: string;
  gcode_state: string | null;
}

// One loaded AMS filament slot (M8 G3): `color` is `#RRGGBB` (alpha stripped)
// or null for an empty/unknown slot.
export interface AmsTray {
  slot: number;
  color: string | null;
  material: string | null;
}

export interface PrinterStatusOut {
  online: boolean;
  gcode_state: string | null;
  mc_percent: number | null;
  layer_num: number | null;
  total_layer_num: number | null;
  mc_remaining_time: number | null;
  print_error: number | null;
  nozzle_temper: number | null;
  bed_temper: number | null;
  subtask_name: string | null;
  wifi_signal: string | null;
  trays: AmsTray[];
}

export type PrintJobState =
  | "queued"
  | "uploading"
  | "starting"
  | "printing"
  | "paused"
  | "finished"
  | "failed"
  | "canceled";

export interface PrintJobOut {
  id: number;
  printer_id: number;
  file_id: number;
  subtask_name: string | null;
  state: PrintJobState;
  progress_pct: number | null;
  remaining_min: number | null;
  layer: number | null;
  total_layers: number | null;
  printer_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface PrintRequest {
  file_id: number;
  plate?: number;
  subtask_name?: string | null;
  use_ams?: boolean;
  ams_mapping?: number[];
  bed_levelling?: boolean;
  flow_cali?: boolean;
  timelapse?: boolean;
}

export interface PrintJobUpdatedEvent {
  type: "print_job.updated";
  print_job_id: number;
  printer_id: number;
  state: PrintJobState;
}

export type AppEvent = JobUpdatedEvent | PrintJobUpdatedEvent;

// -- imports (backend/app/schemas/imports.py, app/models/enums.py) --------

export type ImportSite = "thingiverse" | "printables" | "makerworld";
export type ImportState = "pending" | "fetching" | "downloading" | "done" | "failed";

export interface ImportOut {
  id: number;
  url: string;
  site: ImportSite;
  external_id: string | null;
  state: ImportState;
  model_id: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ImportCreate {
  url: string;
}

export interface ImportTokensIn {
  thingiverse_token: string;
  makerworld_token: string;
}

// "***" when set, "" otherwise
export interface ImportTokensOut {
  thingiverse_token: string;
  makerworld_token: string;
}

// Imports reuse the existing `job.updated` shape (JobUpdatedEvent above) --
// no new event type; only useEvents.tsx's handler gains an
// `import_from_url` branch.

// `GET /imports/search` (Workstream B task B1) -- browse-then-import search
// results for a single site.
export interface SearchResult {
  site: ImportSite;
  external_id: string;
  title: string;
  url: string;
  author: string | null;
  thumbnail_url: string | null;
}

// Per-site outcome of a federated `GET /imports/search` (M8 E1): counts,
// whether another page likely exists, and errors, so the UI can label each
// site and surface which upstream failed or needs a token.
export interface SiteSearchStatus {
  site: ImportSite;
  count: number;
  has_more: boolean;
  status: "ok" | "error";
  detail: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  per_site: SiteSearchStatus[];
}

// -- followed collections + review queue (M8 H) ----------------------------

export type CollectionSyncMode = "auto" | "review";

/** One of the signed-in user's lists on a site (`GET /imports/lists`). */
export interface RemoteList {
  site: ImportSite;
  list_id: string;
  kind: string;
  title: string;
  count: number | null;
}

export interface FollowedCollection {
  id: number;
  site: ImportSite;
  list_id: string;
  kind: string;
  title: string;
  mode: CollectionSyncMode;
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** An item a `review`-mode sync found but didn't import. */
export interface PendingImport {
  id: number;
  collection_id: number;
  site: ImportSite;
  external_id: string;
  title: string;
  url: string;
  thumbnail_url: string | null;
  created_at: string;
}

// -- Bambu Lab account (backend/app/schemas/settings.py, Workstream B task
// B2) -- connecting an account powers MakerWorld's authenticated search +
// file downloads; anonymous MakerWorld access only sees trending results
// and can't download files (see backend/app/services/bambu_auth.py).
// NEITHER request nor response type below ever carries a token.

export type BambuRegion = "global" | "china";

export interface BambuStatusOut {
  connected: boolean;
  account: string | null;
  region: BambuRegion;
  // True iff connected AND the stored refresh token's last refresh attempt
  // failed (import-health task) -- the expiry-banner UX signal so the
  // frontend can tell "not configured" apart from "configured but the
  // session died" (backend/app/schemas/settings.py's BambuStatusOut).
  needs_reconnect: boolean;
}

export interface BambuLoginIn {
  account: string;
  password: string;
  region: BambuRegion;
}

export interface BambuVerifyIn {
  account: string;
  code: string;
  region: BambuRegion;
  mfa_context: Record<string, unknown>;
}

// Shared by both /settings/bambu/login and /settings/bambu/verify --
// `status` is "connected" or "mfa_required"; `mfa_context` is the opaque
// continuation to echo back into a follow-up verify call when MFA is
// required (never a secret value itself).
export interface BambuLoginOut {
  status: "connected" | "mfa_required";
  account: string | null;
  region: BambuRegion | null;
  mfa_context: Record<string, unknown> | null;
}

// -- Printables account (backend/app/schemas/settings.py, Workstream A task
// A1) -- connecting an account is what makes the Saved tab's Printables
// collections/likes sync possible (see backend/app/services/
// printables_auth.py). Printables has no login flow this app can drive
// itself, so "connect" is pasting the browser's `auth.refresh_token` cookie
// value. NEITHER request nor response type below ever carries a token.

export interface PrintablesStatusOut {
  connected: boolean;
  username: string | null;
  user_id: string | null;
}

export interface PrintablesConnectIn {
  refresh_token: string;
}

// -- browser-extension API tokens (backend/app/schemas/settings.py, M10
// Workstream A) -- session-gated mint/list/revoke of the SEPARATE
// bearer-token auth plane the sideloaded extension uses. `ApiTokenMintOut`
// is the ONE place the plaintext token is ever present in a response;
// `ApiTokenOut` (the list shape) never carries the token or its hash.

export interface ApiTokenCreateIn {
  label: string;
}

export interface ApiTokenMintOut {
  id: number;
  label: string;
  token: string;
  created_at: string;
}

export interface ApiTokenOut {
  id: number;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

// -- print history (backend/app/schemas/prints.py, Branch 5 Task 1) --------
// A user-entered log of print attempts, distinct from the print queue's
// worklist (`QueueEntry` below) and `print_jobs`' live send-to-printer
// telemetry (M4, `PrintJobOut` above).

export type PrintResult = "success" | "fail" | "partial";

export interface PrintEntry {
  id: number;
  model_id: number;
  printed_at: string;
  printer_name: string | null;
  filament: string | null;
  result: PrintResult;
  duration_min: number | null;
  notes: string | null;
  created_at: string;
}

// `POST /models/{model_id}/prints` payload -- an omitted `printed_at` lets
// the server default to now (its own `server_default=now()`), and an
// omitted `result` defaults to `"success"` server-side.
export interface PrintCreateIn {
  printed_at?: string;
  printer_name?: string | null;
  filament?: string | null;
  result?: PrintResult;
  duration_min?: number | null;
  notes?: string | null;
}

// `PATCH /prints/{print_id}` payload -- all fields optional; only the ones
// present are applied (backend's `exclude_unset` patch semantics, same as
// `NotePatch`/`ModelPatch`).
export interface PrintPatchIn {
  printed_at?: string;
  printer_name?: string | null;
  filament?: string | null;
  result?: PrintResult;
  duration_min?: number | null;
  notes?: string | null;
}

// -- print queue (backend/app/schemas/queue.py, Branch 4 Task 1) -----------
// An ordered "models to print" worklist. `position` is a dense 1-based rank
// over the whole queue, renumbered on every insert/delete/reorder.

export interface QueueEntry {
  id: number;
  model_id: number;
  position: number;
  added_at: string;
  model: ModelSummary;
}

// -- duplicate-files report (backend/app/schemas/reports.py, Branch 4 Task 1)
// Files sharing a blob hash across more than one model -- reclaimable
// storage from the same content having been imported/uploaded more than once.

export interface DuplicateFile {
  model_id: number;
  model_slug: string;
  model_name: string;
  model_archived: boolean;
  file_id: number;
  file_name: string;
}

export interface DuplicateGroup {
  blob_hash: string;
  size: number;
  wasted_bytes: number;
  files: DuplicateFile[];
}

export interface DuplicatesReport {
  groups: DuplicateGroup[];
  total_wasted_bytes: number;
}
