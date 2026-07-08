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
  imported_at: string | null;
  cover_blob_hash: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  tags: string[];
  current_revision: RevisionDetail | null;
  notes: NoteOut[];
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
}

// "***" when set, "" otherwise
export interface ImportTokensOut {
  thingiverse_token: string;
}

// Imports reuse the existing `job.updated` shape (JobUpdatedEvent above) --
// no new event type; only useEvents.tsx's handler gains an
// `import_from_url` branch.
