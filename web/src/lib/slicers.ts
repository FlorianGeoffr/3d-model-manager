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

const ELIGIBLE_FORMATS: ReadonlySet<BlobFormat> = new Set<BlobFormat>(["stl", "3mf", "step", "obj"]);

/** Raw-geometry formats a desktop slicer can open -- excludes sliced
 * outputs (`gcode`, `gcode_3mf`) and non-model files (images, `other`). */
export function isSlicerEligible(file: FileOut): boolean {
  return ELIGIBLE_FORMATS.has(file.format);
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
