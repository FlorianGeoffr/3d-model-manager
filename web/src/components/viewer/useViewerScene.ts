/**
 * Owns all the state the viewer stage renders from -- checked parts, per-part
 * colors, background, lighting, the printer id, and the pop-out action --
 * lifted out of the model-detail tab so the inline tab, the Expand dialog,
 * and the standalone pop-out window all share ONE implementation. The tab
 * calls it with no `initial`, so it behaves exactly as before; the window
 * seeds it from its URL. Returns a ready-to-spread `stageProps` bundle (the
 * caller only adds the per-surface `variant`/`showExpand`/`showWindowButtons`
 * flags), keeping the assembly in one place instead of duplicated per caller.
 */
import { useEffect, useMemo, useState } from "react";

import { usePrinters } from "@/api/printers";
import { useViewerBackground, type BackgroundPreset } from "@/components/viewer/background";
import { useViewerLighting, type LightingPreset } from "@/components/viewer/lighting";
import {
  encodePartColors,
  loadPartColors,
  savePartColors,
  type PartColors,
} from "@/components/viewer/partColors";
import { useViewerTools, type SceneStats, type ViewerToolsState } from "@/components/viewer/tools";
import type { ViewerStageProps } from "@/components/viewer/ViewerStage";
import { glbUrl, type ViewerPart } from "@/components/viewer/viewable";
import type { FileOut } from "@/api/types";

// Single source for the build-plate's mm side length -- a future settings
// surface can replace this constant with a per-printer value without
// touching anything downstream (`ModelViewer`, `PlateGrid`) that already
// reads it as a prop.
const PLATE_SIZE_MM = 256;

/** Seed values so the pop-out window can start from its URL instead of this
 * tab's localStorage. Every field is optional; absent means "use the tab's
 * normal default" (first part checked, persisted colors/background/lighting,
 * panel open). */
export interface ViewerSceneInitial {
  checkedIds?: number[];
  colors?: PartColors;
  background?: { preset: BackgroundPreset; custom?: string };
  lighting?: LightingPreset;
  panelOpen?: boolean;
  tools?: Partial<ViewerToolsState>;
}

type StagePropsBundle = Omit<
  ViewerStageProps,
  "variant" | "showExpand" | "onExpand" | "showWindowButtons"
>;

export function useViewerScene({
  slug,
  files,
  initial,
  persist = true,
}: {
  slug: string;
  files: FileOut[];
  initial?: ViewerSceneInitial;
  /** Whether this surface writes its state back to shared storage. The tab
   * persists (colors per-model, background/lighting globally). The pop-out
   * window is a URL-derived VIEW and passes `false`: it's seeded with a SUBSET
   * of colors (writing that back would drop the rest of the model's colors),
   * and it reads its background/lighting from the URL, so persisting either
   * would let comparing settings in a pop-out silently change the tab's saved
   * defaults. */
  persist?: boolean;
}): { stageProps: StagePropsBundle } {
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(
    () => new Set(initial?.checkedIds ?? (files[0] ? [files[0].id] : [])),
  );
  const [panelOpen, setPanelOpen] = useState(initial?.panelOpen ?? true);
  const [colors, setColors] = useState<PartColors>(() => initial?.colors ?? loadPartColors(slug));
  const { preset, custom, color, setPreset, setCustom } = useViewerBackground(
    initial?.background,
    persist,
  );
  const { preset: lightingPreset, rig: lighting, setPreset: setLighting } = useViewerLighting(
    initial?.lighting,
    persist,
  );
  const { tools, setTools } = useViewerTools(initial?.tools, persist);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const printers = usePrinters();
  const printerId = printers.data?.[0]?.id;

  useEffect(() => {
    if (!persist) return;
    savePartColors(slug, colors);
  }, [slug, colors, persist]);

  // B1 "toggle-fix core": every combinable file becomes a part, checked or
  // not -- the scene keeps them all mounted and toggles `visible` instead of
  // the checklist changing which parts even exist in the tree (which used to
  // force the whole canvas to remount on every checkbox click). `checkedIds`
  // still drives `visible`, `checkedList`, and the "N of M" header below.
  const parts: ViewerPart[] = useMemo(
    () =>
      files.map((file) => ({
        id: file.id,
        url: glbUrl(file),
        color: colors[file.id],
        visible: checkedIds.has(file.id),
      })),
    [files, checkedIds, colors],
  );

  function toggleFile(fileId: number, checked: boolean) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(fileId);
      } else {
        next.delete(fileId);
      }
      return next;
    });
  }

  function setPartColor(fileId: number, hex: string) {
    setColors((prev) => ({ ...prev, [fileId]: hex }));
  }

  function clearPartColor(fileId: number) {
    setColors((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  }

  const checkedList = [...checkedIds];
  const hasColors = Object.keys(colors).length > 0;

  // Open the current selection (or a single part) in its OWN browser window
  // (M8 G1). The window re-derives everything from the URL so it matches what's
  // shown here at open time. `bg` carries the background PRESET (not a resolved
  // hex) so the window's Background control lands on the right segment; `bgc`
  // carries the custom hex only when that preset is "custom"; `light` carries
  // the lighting preset. Multiple windows are cheap -- GLB urls are
  // content-addressed.
  function openInWindow(ids: number[]) {
    const params = new URLSearchParams({ ids: ids.join(","), bg: preset, light: lightingPreset });
    if (preset === "custom") params.set("bgc", custom);
    const subset: PartColors = {};
    for (const id of ids) if (colors[id]) subset[id] = colors[id];
    const encoded = encodePartColors(subset);
    if (encoded) params.set("colors", encoded);
    window.open(`/viewer/${slug}?${params.toString()}`, "_blank", "popup=1,width=1024,height=768,noopener");
  }

  const stageProps: StagePropsBundle = {
    files,
    checkedIds,
    onToggleFile: toggleFile,
    colors,
    onSetPartColor: setPartColor,
    onClearPartColor: clearPartColor,
    hasColors,
    onResetColors: () => setColors({}),
    preset,
    custom,
    background: color,
    onPresetChange: setPreset,
    onCustomChange: setCustom,
    lightingPreset,
    lighting,
    onLightingChange: setLighting,
    printerId,
    onApplyAmsColors: (map) => setColors((prev) => ({ ...prev, ...map })),
    parts,
    checkedList,
    onOpenWindow: openInWindow,
    panelOpen,
    onTogglePanel: () => setPanelOpen((prev) => !prev),
    tools,
    onToolsChange: setTools,
    stats,
    onStats: setStats,
    plateSize: PLATE_SIZE_MM,
  };

  return { stageProps };
}
