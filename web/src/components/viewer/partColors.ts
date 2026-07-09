/** Per-part color overrides for the 3D viewer (M8 G2): a map of file id ->
 * "#RRGGBB". Persisted per model in localStorage (so reopening keeps your
 * colors) and also encoded into the standalone viewer window's URL (G1) so a
 * popped-out window renders the same colors. Non-destructive — never touches
 * the stored GLB, only the viewer's rendering. */
export type PartColors = Record<number, string>;

const KEY_PREFIX = "viewer-colors:";
const HEX = /^#[0-9a-fA-F]{6}$/;

function sanitize(raw: unknown): PartColors {
  if (!raw || typeof raw !== "object") return {};
  const out: PartColors = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (Number.isInteger(id) && typeof value === "string" && HEX.test(value)) out[id] = value;
  }
  return out;
}

export function loadPartColors(slug: string): PartColors {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + slug);
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function savePartColors(slug: string, colors: PartColors): void {
  try {
    localStorage.setItem(KEY_PREFIX + slug, JSON.stringify(colors));
  } catch {
    // ignore storage errors (private mode, quota) — colors are a nicety
  }
}

/** Encode as a URL search value: "id:rrggbb,id:rrggbb" (hex without '#'). */
export function encodePartColors(colors: PartColors): string {
  return Object.entries(colors)
    .map(([id, hex]) => `${id}:${hex.replace(/^#/, "")}`)
    .join(",");
}

export function decodePartColors(encoded: string | null | undefined): PartColors {
  if (!encoded) return {};
  const out: PartColors = {};
  for (const pair of encoded.split(",")) {
    const [idStr, hex] = pair.split(":");
    const id = Number(idStr);
    if (Number.isInteger(id) && hex && HEX.test(`#${hex}`)) out[id] = `#${hex}`;
  }
  return out;
}
