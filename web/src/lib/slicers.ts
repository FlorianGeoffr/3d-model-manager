import type { BlobFormat, FileOut } from "@/api/types";

export interface SlicerOption {
  id: string;
  label: string;
  scheme: string;
}

/** Order matters only for menu display -- the first entry is just the
 * fallback default when nothing's been picked yet. */
export const SLICER_OPTIONS: SlicerOption[] = [
  { id: "orcaslicer", label: "OrcaSlicer", scheme: "orcaslicer" },
  { id: "bambustudio", label: "Bambu Studio", scheme: "bambustudio" },
  { id: "prusaslicer", label: "PrusaSlicer", scheme: "prusaslicer" },
  { id: "elegooslicer", label: "Elegoo Slicer", scheme: "elegooslicer" },
];

const ELIGIBLE_FORMATS: ReadonlySet<BlobFormat> = new Set<BlobFormat>([
  "stl",
  "3mf",
  "step",
  "obj",
  "iges",
  "gcode_3mf",
  "gcode",
]);

/** Raw-geometry and sliced formats a desktop slicer can open -- excludes
 * non-model files (images, `other`). */
export function isSlicerEligible(file: FileOut): boolean {
  return ELIGIBLE_FORMATS.has(file.format);
}

/** Preference order for the header's single "Open in slicer" target when
 * multiple eligible files exist on the current revision -- a `3mf` (already
 * project-shaped) beats a bare `step`, which beats `obj`/`iges`/`gcode_3mf`/`gcode`.
 * Ties within a format break on `rel_path` for a deterministic pick. */
export const SLICER_FORMAT_PRIORITY: readonly BlobFormat[] = [
  "3mf",
  "step",
  "obj",
  "stl",
  "iges",
  "gcode_3mf",
  "gcode",
];

/** Picks the single best slicer-eligible, verified file on a revision's file
 * list -- `SLICER_FORMAT_PRIORITY` order, then `rel_path` to break ties.
 * Returns `undefined` when nothing qualifies. */
export function pickBestSlicerFile(files: FileOut[]): FileOut | undefined {
  const eligible = files.filter((file) => file.verified_at && isSlicerEligible(file));
  return eligible.sort((a, b) => {
    const rank = SLICER_FORMAT_PRIORITY.indexOf(a.format) - SLICER_FORMAT_PRIORITY.indexOf(b.format);
    return rank !== 0 ? rank : a.rel_path.localeCompare(b.rel_path);
  })[0];
}

export const LAST_SLICER_STORAGE_KEY = "tdmm.lastSlicer";

export function readLastSlicer(): SlicerOption {
  try {
    const id = localStorage.getItem(LAST_SLICER_STORAGE_KEY);
    return SLICER_OPTIONS.find((s) => s.id === id) ?? SLICER_OPTIONS[0];
  } catch {
    return SLICER_OPTIONS[0];
  }
}

export function rememberLastSlicer(id: string): void {
  try {
    localStorage.setItem(LAST_SLICER_STORAGE_KEY, id);
  } catch {
    // Best-effort only -- a private window/blocked storage just means the
    // primary action doesn't persist between visits.
  }
}
