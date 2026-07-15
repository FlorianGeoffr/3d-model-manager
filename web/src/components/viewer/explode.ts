/**
 * Pure, three.js-free core of the viewer's explode/separate control. The
 * "Explode" slider fans a multi-part model's parts apart; each "part" is one
 * GLB file loaded into a shared scene. The old behavior offset every part by
 * `(partCenter - assemblyCenter) * explode`, which is a no-op when parts
 * overlap at the origin -- the common case for a set of separate STL files
 * that were each authored/centered on their own origin rather than
 * pre-arranged into an assembly.
 *
 * `explodeLayout` classifies the scene first, then picks a matching layout:
 *  - a real assembly (parts already spread apart) explodes radially, same as
 *    before;
 *  - an overlapping pile (near-zero spread) falls back to a grid layout on
 *    the horizontal plane so the parts visibly separate instead of sitting
 *    on top of each other;
 *  - fewer than two parts, or degenerate (zero-size) geometry, has nothing
 *    to explode.
 *
 * Offsets are returned in **native mm**, not normalized/scene units --
 * `ModelViewer` applies them to each part's group *inside* a `Center`/
 * `Resize` stack that rescales the whole subtree, so pre-scaling here would
 * be double-applied. See `tools.ts`'s header/`sectionPlaneParams` for the
 * same native-mm-vs-normalized-scene distinction and the "leaf module, no
 * three.js import" house style this file follows.
 */

export type ExplodeMode = "explode" | "separate" | "none";

/** One loaded part's native-mm axis-aligned bounding box, as plain numbers
 *  (no three.js here -- ModelViewer reads these off a THREE.Box3 and passes
 *  them in). `center` is the box center, `size` its full extents. */
export interface PartExtent {
  id: number;
  center: [number, number, number];
  size: [number, number, number];
}

export interface ExplodeLayout {
  mode: ExplodeMode;
  offsets: Map<number, [number, number, number]>; // part id -> native-mm group offset
}

/** A part's center displaced from the assembly center by more than this
 * fraction of the largest part's max dimension counts as a genuine
 * (radially-explodable) assembly; an overlapping pile has ~zero spread. */
export const POSITIONED_FRACTION = 0.25;

/** Grid gap as a fraction of the largest cell dimension, for the "separate"
 * (overlapping-pile) grid layout. */
export const GAP_FRACTION = 0.2;

/** Classifies the scene as a real assembly, an overlapping pile, or nothing
 * to explode, then returns per-part native-mm offsets for the given
 * `explode` amount (0..1). Both branches are linear in `explode`, so
 * `explode === 0` always yields all-zero offsets -- the resting view must be
 * untouched. The `id`s in the returned map are exactly the input part ids.
 *
 * - **positioned (`mode: "explode"`)**: parts are already spread apart, so
 *   each part is offset radially away from the assembly center:
 *   `offset = (center - allCenter) * explode`, on all three axes. This
 *   reproduces the pre-existing behavior exactly.
 * - **overlapping (`mode: "separate"`)**: parts all sit near the same
 *   center (the common "separate STL files each centered on their own
 *   origin" case), so a radial offset would be a no-op. Instead each part is
 *   assigned a cell in a grid on the horizontal XZ plane (the scene is Y-up,
 *   so sliding apart horizontally rather than dropping/rising keeps the
 *   parts on the build plate); the Y offset is always 0.
 */
export function explodeLayout(parts: PartExtent[], explode: number): ExplodeLayout {
  if (parts.length < 2) return { mode: "none", offsets: new Map() };

  const axes = [0, 1, 2] as const;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    for (const a of axes) {
      const lo = part.center[a] - part.size[a] / 2;
      const hi = part.center[a] + part.size[a] / 2;
      if (lo < min[a]) min[a] = lo;
      if (hi > max[a]) max[a] = hi;
    }
  }
  const allCenter: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];

  let maxSpread = 0;
  let maxPartDim = 0;
  for (const part of parts) {
    const dx = part.center[0] - allCenter[0];
    const dy = part.center[1] - allCenter[1];
    const dz = part.center[2] - allCenter[2];
    const spread = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (spread > maxSpread) maxSpread = spread;

    const dim = Math.max(part.size[0], part.size[1], part.size[2]);
    if (dim > maxPartDim) maxPartDim = dim;
  }

  if (maxPartDim <= 0) return { mode: "none", offsets: new Map() };

  const positioned = maxSpread > POSITIONED_FRACTION * maxPartDim;

  // `delta * 0` is `-0` for a negative `delta`, which is numerically zero
  // but not identical to `+0` -- special-case `explode === 0` so "the
  // resting view must be untouched" holds for strict/deep equality too, not
  // just numeric equality.
  const scale = (delta: number): number => (explode === 0 ? 0 : delta * explode);

  if (positioned) {
    const offsets = new Map<number, [number, number, number]>();
    for (const part of parts) {
      offsets.set(part.id, [
        scale(part.center[0] - allCenter[0]),
        scale(part.center[1] - allCenter[1]),
        scale(part.center[2] - allCenter[2]),
      ]);
    }
    return { mode: "explode", offsets };
  }

  // Overlapping pile: grid layout on the horizontal XZ plane. Cell
  // assignment is keyed by ascending part id (not input order) so a
  // shuffled input array produces identical offsets per id.
  const sortedIds = parts.map((part) => part.id).sort((a, b) => a - b);
  const byId = new Map(parts.map((part) => [part.id, part]));

  const n = parts.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  let cellW = 0;
  let cellD = 0;
  for (const part of parts) {
    if (part.size[0] > cellW) cellW = part.size[0];
    if (part.size[2] > cellD) cellD = part.size[2];
  }
  const gap = GAP_FRACTION * Math.max(cellW, cellD);
  const stepX = cellW + gap;
  const stepZ = cellD + gap;

  const offsets = new Map<number, [number, number, number]>();
  sortedIds.forEach((id, k) => {
    const part = byId.get(id);
    if (!part) return;

    const col = k % cols;
    const row = Math.floor(k / cols);
    const gx = (col - (cols - 1) / 2) * stepX;
    const gz = (row - (rows - 1) / 2) * stepZ;

    const targetX = allCenter[0] + gx;
    const targetZ = allCenter[2] + gz;

    offsets.set(id, [scale(targetX - part.center[0]), 0, scale(targetZ - part.center[2])]);
  });

  return { mode: "separate", offsets };
}

/** Honest label for the explode control given its current mode: `"explode"`
 * is a real assembly fanning apart radially, `"separate"` is an overlapping
 * pile sliding apart into a grid. `"none"` has no visible control (the
 * caller hides it), so its label is unused but the function must stay
 * total. */
export function explodeControlLabel(mode: ExplodeMode): string {
  switch (mode) {
    case "explode":
      return "Explode";
    case "separate":
      return "Separate parts";
    case "none":
      return "";
  }
}
