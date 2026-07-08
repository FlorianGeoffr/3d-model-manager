/**
 * Pure helpers for picking/addressing viewable files on a model's current
 * revision (Task 8). Kept free of React/three so they're trivially unit
 * testable under plain vitest (no Canvas/WebGL involved).
 */
import type { FileOut, ModelDetail } from "@/api/types";

// Mirrors `PREVIEW_TRIANGLE_THRESHOLD` in `backend/app/tasks/pipeline.py` —
// keep in sync by hand (Global Constraints "types.ts" convention).
const PREVIEW_TRIANGLE_THRESHOLD = 1_500_000;

/** `GET /api/blobs/{hash}/glb`, requesting the decimated preview LOD once
 * it's ready for meshes heavy enough to need it. */
export function glbUrl(file: FileOut): string {
  const wantsPreview =
    file.glb_preview_ready && (file.meta?.triangle_count ?? 0) > PREVIEW_TRIANGLE_THRESHOLD;
  const query = wantsPreview ? "?preview=true" : "";
  return `/api/blobs/${file.blob_hash}/glb${query}`;
}

/** Files on the model's current revision that the viewer tab can offer in
 * its file picker: anything the pipeline produces (or could produce) a GLB
 * for (`glb_status !== null`), plus sliced files (Task 9's plate panel) and
 * plain `.gcode` (no 3D preview, but still selectable — SPEC's "no preview"
 * card). Returned in `rel_path` order. */
export function pickViewerFiles(model: ModelDetail): FileOut[] {
  const files = model.current_revision?.files ?? [];
  return files
    .filter((file) => file.glb_status !== null || file.kind === "sliced" || file.format === "gcode")
    .sort((a, b) => a.rel_path.localeCompare(b.rel_path));
}

/** The subset of `pickViewerFiles` with a ready-to-render GLB -- the only
 * files that can be combined into one multi-part scene (Workstream A
 * "multi-part combined view"). Sliced files and plain gcode never have a
 * mesh to combine, and pending/failed/unsupported GLBs have no scene to
 * render yet. */
export function glbFiles(model: ModelDetail): FileOut[] {
  return pickViewerFiles(model).filter((file) => file.glb_status === "ok");
}
