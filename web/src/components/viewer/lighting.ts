/**
 * Viewer lighting presets + persistence (mirrors `background.ts`'s
 * pure-resolver + persisted-hook split). `resolveLighting` is a pure
 * function so it's trivially unit testable under plain vitest;
 * `useViewerLighting` is the stateful half that persists the choice across
 * sessions -- unless the caller seeds it with an `initial` preset instead
 * (the pop-out window, which derives its lighting from its own URL rather
 * than this tab's localStorage).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type LightingPreset = "studio" | "bright" | "flat";

/** Order + labels for the picker UI. */
export const LIGHTING_PRESET_ORDER: readonly LightingPreset[] = ["studio", "bright", "flat"];

export const LIGHTING_PRESET_LABELS: Record<LightingPreset, string> = {
  studio: "Studio",
  bright: "Bright",
  flat: "Flat",
};

export interface LightingRig {
  exposure: number; // renderer.toneMappingExposure
  ambient: number; // ambientLight intensity
  key: number; // front-top directional intensity
  fill: number; // side directional intensity
  rim: number; // back directional intensity
  env: number; // drei <Environment environmentIntensity>
  contactShadow: boolean; // ground shadow on/off
  ao: boolean; // screen-space ambient occlusion on/off
}

// Starting points, tuned against screenshots in a later pass -- not final.
const STUDIO_RIG: LightingRig = { exposure: 1.0, ambient: 0.25, key: 1.6, fill: 0.55, rim: 0.9, env: 0.85, contactShadow: true, ao: true };
const BRIGHT_RIG: LightingRig = { exposure: 1.25, ambient: 0.55, key: 2.0, fill: 0.9, rim: 1.1, env: 1.1, contactShadow: true, ao: true };
// The old shadowless, evenly-lit look, kept as a deliberate escape hatch:
// a dominant ambient term and no contact shadow so raw geometry/topology
// can be inspected without the studio/bright rigs' shading obscuring it. AO
// would contradict that same escape hatch (it shades crevices/contact
// points), so it's off here too.
const FLAT_RIG: LightingRig = { exposure: 1.0, ambient: 1.1, key: 0.6, fill: 0.6, rim: 0.3, env: 0.35, contactShadow: false, ao: false };

/** Pure preset -> rig resolution. */
export function resolveLighting(preset: LightingPreset): LightingRig {
  switch (preset) {
    case "bright":
      return BRIGHT_RIG;
    case "flat":
      return FLAT_RIG;
    case "studio":
    default:
      return STUDIO_RIG;
  }
}

const STORAGE_KEY = "viewer-lighting";

function isLightingPreset(value: unknown): value is LightingPreset {
  return typeof value === "string" && (LIGHTING_PRESET_ORDER as readonly string[]).includes(value);
}

function readStoredPreset(): LightingPreset {
  if (typeof window === "undefined") return "studio";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isLightingPreset(raw) ? raw : "studio";
  } catch {
    // Corrupt storage / disabled localStorage -- fall back to the default
    // rather than crashing the viewer tab over a persistence nicety.
    return "studio";
  }
}

function writeStoredPreset(preset: LightingPreset): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Best-effort only (private browsing / quota exceeded).
  }
}

/** Persists the chosen lighting preset in localStorage and resolves it to a
 * `LightingRig`. Pass `initial` to seed the state directly instead -- the
 * pop-out window decodes its preset from the URL and must not clobber it
 * with whatever's in this tab's localStorage on first render. An invalid
 * `initial` degrades to the studio default the same as a corrupt persisted
 * value would. `persist=false` makes this a read/seed-only view: the pop-out
 * window derives its lighting from the URL and must NOT write it back, or
 * comparing lighting in a pop-out would silently change the tab's default. */
export function useViewerLighting(
  initial?: LightingPreset,
  persist = true,
): {
  preset: LightingPreset;
  rig: LightingRig;
  setPreset: (preset: LightingPreset) => void;
} {
  const [preset, setPresetState] = useState<LightingPreset>(() =>
    initial !== undefined ? (isLightingPreset(initial) ? initial : "studio") : readStoredPreset(),
  );

  // Skip the initial run: `preset` was just seeded or read back from
  // localStorage, so persisting it again on mount would be a redundant
  // no-op write. Only real changes (via `setPreset`) should hit storage, and
  // only when this surface is allowed to persist at all.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (persist) writeStoredPreset(preset);
  }, [preset, persist]);

  const setPreset = useCallback((next: LightingPreset) => {
    setPresetState(next);
  }, []);

  return { preset, rig: resolveLighting(preset), setPreset };
}
