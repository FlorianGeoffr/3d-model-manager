/**
 * Viewer tools state (build-plate grid, wireframe, auto-rotate, ortho
 * camera, cross-section, explode) + persistence. Mirrors `lighting.ts`'s
 * persisted-hook shape, but only ONE field (`grid`) is actually persisted --
 * the rest are session-only view toggles that shouldn't outlive the tab (an
 * exploded/wireframed/auto-rotating view left on from a previous session
 * would be a confusing default the next time a model opens, unlike the
 * grid, which is a stable preference). Leaf module, no three.js imports, so
 * it's safe to import from the main bundle (`useViewerScene.ts` holds the
 * state) as well as the lazy `ModelViewer` chunk (Global Constraints
 * "BUNDLE RULE") for the `ViewerToolsState`/`SceneStats` types.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SectionAxis = "x" | "y" | "z";

/** Cross-section clip state (Task 5 wires the actual clipping plane). `t` is
 * the sweep position along `axis`, 0..1 across the model's bounding box. */
export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  t: number;
}

/** The combined visible scene's real-world size + triangle count, in mm --
 * reported by `ModelViewer` (see its stats-reporting effect) and rendered by
 * `ViewerStage`'s stats overlay chip via `formatStats`. */
export interface SceneStats {
  x: number;
  y: number;
  z: number;
  triangles: number;
}

export interface ViewerToolsState {
  grid: boolean; // build-plate grid (persisted)
  wireframe: boolean; // Task 5 wires
  autoRotate: boolean; // Task 4 wires
  ortho: boolean; // Task 4 wires
  section: SectionState; // Task 5 wires
  explode: number; // 0..1, Task 5 wires
}

/** The imperative surface `ModelViewer` publishes into `ViewerStage`'s
 * `viewerApiRef` (via `scene/helpers.tsx`'s `CaptureBridge`) for actions that
 * have no prop path from a DOM button click into a `<Canvas>` child --
 * today just the screenshot button. No three.js imports here (leaf module,
 * see the file header) -- the `Blob` this resolves is a canvas capture, not
 * a three.js type. */
export interface ViewerApi {
  screenshot: () => Promise<Blob | null>;
}

export const DEFAULT_TOOLS: ViewerToolsState = {
  grid: true,
  wireframe: false,
  autoRotate: false,
  ortho: false,
  section: { enabled: false, axis: "x", t: 0.5 },
  explode: 0,
};

const STORAGE_KEY = "viewer-tools";

interface StoredTools {
  grid: boolean;
}

function readStoredGrid(): boolean {
  if (typeof window === "undefined") return DEFAULT_TOOLS.grid;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TOOLS.grid;
    const parsed = JSON.parse(raw) as Partial<StoredTools> | null;
    return typeof parsed?.grid === "boolean" ? parsed.grid : DEFAULT_TOOLS.grid;
  } catch {
    // Corrupt JSON / disabled storage -- fall back to the default rather
    // than crashing the viewer tab over a persistence nicety.
    return DEFAULT_TOOLS.grid;
  }
}

function writeStoredGrid(grid: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ grid } satisfies StoredTools));
  } catch {
    // Best-effort only (private browsing / quota exceeded).
  }
}

/** Humanizes a triangle count for the stats chip: `842`, `12.4k`, `1.2M`. */
function formatTriangles(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${Math.round(count)}`;
}

/** `"220.4 × 180.0 × 45.2 mm · 1.2M tris"` -- dims to 1 decimal (native GLB
 * units are mm, see `ModelViewer.tsx`'s stats-reporting effect), triangle
 * count humanized. */
export function formatStats(stats: SceneStats): string {
  const dims = [stats.x, stats.y, stats.z].map((value) => value.toFixed(1)).join(" × ");
  return `${dims} mm · ${formatTriangles(stats.triangles)} tris`;
}

/** Persists ONLY `grid` in localStorage -- every other field is session-only
 * (see the file header) and never read from or written to storage. Pass
 * `initial` to seed the whole state directly instead of reading storage --
 * mirrors `useViewerLighting`'s `initial`/`persist` contract so the pop-out
 * window can seed from its own source (today: nothing, tomorrow: its own
 * URL) without clobbering or being clobbered by this tab's localStorage.
 * Seed order for `grid` specifically: `initial.grid` wins over the stored
 * value, which wins over the default. `persist=false` makes this a
 * read/seed-only view that never writes `grid` back -- same rationale as
 * `useViewerLighting`'s pop-out-window case. */
export function useViewerTools(
  initial?: Partial<ViewerToolsState>,
  persist = true,
): {
  tools: ViewerToolsState;
  setTools: (patch: Partial<ViewerToolsState>) => void;
} {
  const [tools, setToolsState] = useState<ViewerToolsState>(() => {
    const grid = initial?.grid ?? readStoredGrid();
    return { ...DEFAULT_TOOLS, ...initial, grid };
  });

  // Skip the initial run: `tools.grid` was just seeded or read back from
  // localStorage, so persisting it again on mount would be a redundant
  // no-op write. Only real changes should hit storage, and only when this
  // surface is allowed to persist at all. Depending on `tools.grid` alone
  // (not the whole `tools` object) means a patch that only touches
  // `wireframe`/`autoRotate`/etc. never re-runs this effect at all -- the
  // "only grid persisted" contract falls out of the dependency array, not
  // an extra check.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (persist) writeStoredGrid(tools.grid);
  }, [tools.grid, persist]);

  const setTools = useCallback((patch: Partial<ViewerToolsState>) => {
    setToolsState((prev) => ({ ...prev, ...patch }));
  }, []);

  return { tools, setTools };
}
