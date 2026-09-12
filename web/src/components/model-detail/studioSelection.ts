/** What the rail's selection points at -- the synthetic combined-assembly
 * entry, or one non-combinable file (sliced/gcode/pending/failed/
 * unsupported). Shared with `StudioWorkspace`/`StudioSurface` so all three
 * agree on the shape without a circular import. */
export type StudioSelection = { type: "assembly" } | { type: "file"; id: number };

export function isSameSelection(a: StudioSelection | undefined, b: StudioSelection): boolean {
  if (!a) return false;
  if (a.type === "assembly") return b.type === "assembly";
  return b.type === "file" && a.id === b.id;
}
