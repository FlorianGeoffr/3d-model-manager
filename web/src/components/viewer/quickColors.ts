/**
 * The dock's 7-swatch "quick color" row (R13a GyroidVault re-chrome): one
 * click bulk-paints every checked part the same color, writing into the SAME
 * `colors` map a per-part override would (`useViewerScene`'s `setAllColors`
 * -- see Key decision 2 in the R13 plan: "Quick swatch = bulk write into the
 * same colors map; per-part override overwrites one key; Reset clears
 * both"). Leaf module, no three.js import (house style shared with
 * `tools.ts`/`explode.ts`/`partColors.ts`), so it's cheap to unit test and
 * safe to import from the main bundle.
 */
import type { PartColors } from "@/components/viewer/partColors";

/** Fixed order + hex values for the dock's quick-swatch row. Distinct hues
 * chosen to read clearly against any of the viewer's background presets. */
export const QUICK_COLORS: readonly string[] = [
  "#00ccee", // cyan
  "#ff8a00", // orange
  "#22c55e", // green
  "#a855f7", // purple
  "#eab308", // gold
  "#f5f5f5", // white
  "#64748b", // slate
];

/** Pure bulk-write: returns a NEW `PartColors` map with every id in `ids` set
 * to `hex`, leaving every other entry untouched. Never mutates `colors`. */
export function applyToParts(colors: PartColors, ids: readonly number[], hex: string): PartColors {
  if (ids.length === 0) return colors;
  const next = { ...colors };
  for (const id of ids) next[id] = hex;
  return next;
}
