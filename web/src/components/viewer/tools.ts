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

/** Task 5 inspection shading, mutually exclusive by construction (an enum,
 * not independent booleans): `"wireframe"` renders every owned material's
 * edges only (the pre-R10 `wireframe: boolean`), `"xray"` (R10) makes them
 * translucent double-sided instead (`transparent`/`opacity: 0.35`/
 * `depthWrite: false`/`side: DoubleSide` -- see `ModelViewer.tsx`'s
 * `GltfPart` owned-materials effect for where these apply and restore). */
export type Shading = "solid" | "wireframe" | "xray";

/** R10 camera presets: tweens the camera to look down a fixed world-space
 * direction (`ModelViewer.tsx`'s `CameraPresetTween`, reusing drei
 * `GizmoHelper`'s `tweenCamera` -- the same machinery the view-cube's face
 * clicks use) and refits to the current bounds. `null` means "no preset is
 * active" -- the default (an untouched load happens to frame roughly like
 * `"iso"`, but nobody chose that, so the segmented control shows nothing
 * selected rather than lying about it), and it goes back to `null` the
 * moment the user manually orbits (see `ModelViewer.tsx`'s
 * `OrbitPresetGuard`). */
export type CameraPreset = "iso" | "top" | "front" | "side" | null;

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

/** A world-space (normalized-scene) clipping plane, as plain numbers --
 * `ModelViewer` constructs the actual `THREE.Plane` from this (see this
 * file's header: no three.js import here). */
export interface SectionPlaneParams {
  normal: [number, number, number];
  constant: number;
}

/** World-space clipping plane for the normalized scene. The model is
 * `Resize`-scaled by `s = 1 / maxDim` and `Center`-ed (x/z centered, bottom
 * at y=0) -- `size` is the pre-scale native-mm box size (`ModelViewer`'s
 * `allBox`) and `scaleFactor` is that same `s`. `normal` is the negative
 * unit axis (e.g. x -> `[-1, 0, 0]`): three.js clipping keeps a point `p`
 * where `dot(normal, p) + constant >= 0`, which for a negative normal
 * reduces to `p_axis <= constant`. World extents per axis: x/z are centered
 * around the origin (`[-size.a * s / 2, +size.a * s / 2]`); y runs from the
 * ground up (`[0, size.y * s]`) since `Center top` grounds the model at
 * y=0. `constant` sweeps from `worldMin` to `worldMax` as `t` goes 0 -> 1,
 * so `t=0` keeps only `p_axis <= worldMin` (nothing) and `t=1` keeps
 * `p_axis <= worldMax` (everything). */
export function sectionPlaneParams(
  section: SectionState,
  size: { x: number; y: number; z: number },
  scaleFactor: number,
): SectionPlaneParams {
  const { axis, t } = section;
  const normal: [number, number, number] =
    axis === "x" ? [-1, 0, 0] : axis === "y" ? [0, -1, 0] : [0, 0, -1];

  const extent = size[axis] * scaleFactor;
  const worldMin = axis === "y" ? 0 : -extent / 2;
  const worldMax = axis === "y" ? extent : extent / 2;
  const constant = worldMin + (worldMax - worldMin) * t;

  return { normal, constant };
}

export interface ViewerToolsState {
  grid: boolean; // build-plate grid (persisted)
  shading: Shading; // Task 5 wireframe + R10 xray
  autoRotate: boolean; // Task 4 wires
  ortho: boolean; // Task 4 wires
  section: SectionState; // Task 5 wires
  explode: number; // 0..1, Task 5 wires
  cameraPreset: CameraPreset; // R10 camera presets
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
  shading: "solid",
  autoRotate: false,
  ortho: false,
  section: { enabled: false, axis: "x", t: 0.5 },
  explode: 0,
  cameraPreset: null,
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
    setToolsState((prev) => {
      const hasChange = Object.entries(patch).some(
        ([k, v]) => prev[k as keyof ViewerToolsState] !== v,
      );
      if (!hasChange) return prev;
      return { ...prev, ...patch };
    });
  }, []);

  return { tools, setTools };
}
