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

export type JobState = "queued" | "running" | "done" | "failed";

export interface JobOut {
  id: string;
  celery_id: string | null;
  type: string;
  subject_type: string | null;
  subject_id: number | null;
  state: JobState;
  attempts: number;
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

// -- events (SSE, Global Constraints) --------------------------------

export interface JobUpdatedEvent {
  type: "job.updated";
  job_id: string;
  job_type: string;
  state: JobState;
  subject_type: string | null;
  subject_id: number | null;
}
