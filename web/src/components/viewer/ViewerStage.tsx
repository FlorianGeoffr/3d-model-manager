import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BoxIcon,
  CameraIcon,
  ExternalLinkIcon,
  Grid3x3Icon,
  LoaderCircleIcon,
  Maximize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ScanIcon,
  TriangleDashedIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHotkeys } from "@/hooks/useHotkeys";
import { cn } from "@/lib/utils";
import { usePrinterStatus } from "@/api/printers";
import { FilamentChip } from "@/components/ui/filament-chip";
import { BackgroundSwatches } from "@/components/viewer/BackgroundSwatches";
import { SegmentedControl } from "@/components/viewer/SegmentedControl";
import type { BackgroundPreset } from "@/components/viewer/background";
import { explodeControlLabel } from "@/components/viewer/explode";
import type { ExplodeMode } from "@/components/viewer/explode";
import {
  LIGHTING_PRESET_LABELS,
  LIGHTING_PRESET_ORDER,
  type LightingPreset,
  type LightingRig,
} from "@/components/viewer/lighting";
import { traysToPartColors, type PartColors } from "@/components/viewer/partColors";
import {
  formatStats,
  type CameraPreset,
  type SceneStats,
  type SectionAxis,
  type ViewerApi,
  type ViewerToolsState,
} from "@/components/viewer/tools";
import type { ViewerPart } from "@/components/viewer/viewable";
import type { FileOut } from "@/api/types";

// three.js/@react-three/fiber/drei are heavy (Global Constraints "BUNDLE
// RULE") — load them only once a GLB actually needs rendering, so the main
// bundle never pays for the viewer on pages that don't render this stage.
const ModelViewer = lazy(() => import("@/components/viewer/ModelViewer"));

// Order + labels for the cross-section's axis picker (Task 5) -- mirrors the
// Background/Lighting `SegmentedControl` usages below.
const SECTION_AXIS_OPTIONS: readonly SectionAxis[] = ["x", "y", "z"];
const SECTION_AXIS_LABELS: Record<SectionAxis, string> = { x: "X", y: "Y", z: "Z" };

// R10 camera presets -- mirrors the Section axis picker above. `Exclude<...,
// null>` since the segmented control's OPTIONS are always the four concrete
// presets; `null` ("no preset active") is only ever the current `value`, see
// `SegmentedControl`'s nullable-value support.
type CameraPresetOption = Exclude<CameraPreset, null>;
const CAMERA_PRESET_OPTIONS: readonly CameraPresetOption[] = ["iso", "top", "front", "side"];
const CAMERA_PRESET_LABELS: Record<CameraPresetOption, string> = {
  iso: "Iso",
  top: "Top",
  front: "Front",
  side: "Side",
};

/** A centered card used for every "nothing to render here" state -- shared by
 * this stage's empty-selection case and `ViewerTab`'s file-status cards
 * (pending / failed / unsupported / plain gcode), so it's exported rather
 * than duplicated. */
export function PlaceholderCard({
  title,
  description,
  destructive = false,
}: {
  title: string;
  description: string;
  destructive?: boolean;
}) {
  return (
    <Card className="mx-auto mt-8 max-w-md">
      <CardHeader className="items-center text-center">
        <CardTitle className={destructive ? "text-destructive" : undefined}>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

// React has no hook form for error boundaries (`componentDidCatch`/
// `getDerivedStateFromError` are class-only APIs), and this project has no
// `react-error-boundary` dependency or existing boundary pattern to reuse
// -- a tiny local class is the documented fallback (M2-Minor 1). Without
// this, a GLB fetch/parse throw from the lazy R3F viewer propagates past
// this tab to the router's top-level error surface, taking down the whole
// model-detail page instead of just this one preview.
interface ViewerErrorBoundaryProps {
  children: ReactNode;
  /** B1 "toggle-fix core": used to be a `key` on this boundary (the joined
   * checked ids), which cleared a stuck error by remounting the boundary --
   * and everything under it, including the `<Canvas>` -- on every checkbox
   * toggle, not just after a crash. Now it's a plain prop: parts stay
   * mounted, and `getDerivedStateFromProps` below clears `hasError` itself
   * the next time the checked selection actually changes (comparing against
   * the resetKey the error happened under, tracked in state), so a crash
   * doesn't get stuck on the fallback forever without remounting anything. */
  resetKey: string;
  /** Fix wave finding 3: lets `ViewerStage` know the canvas crashed so it can
   * drop the thumbnail crossfade cover -- otherwise a load failure left the
   * cover image sitting opaque over this boundary's own fallback forever
   * (the cover only ever cleared on `onPartLoaded`, which a crash never
   * fires). */
  onError?: () => void;
}

interface ViewerErrorBoundaryState {
  hasError: boolean;
  resetKey: string;
}

class ViewerErrorBoundary extends Component<ViewerErrorBoundaryProps, ViewerErrorBoundaryState> {
  state: ViewerErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Pick<ViewerErrorBoundaryState, "hasError"> {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  // Derives state from props instead of a `componentDidUpdate` + `setState`
  // pair (oxlint's `react/no-did-update-set-state` flags that combination as
  // update-thrashing-prone) -- functionally the same reset, just expressed
  // as a pure props+state -> state mapping: whenever `resetKey` changes,
  // clear `hasError` (a no-op if it was already false) and resync the
  // tracked key for the next comparison.
  static getDerivedStateFromProps(
    props: ViewerErrorBoundaryProps,
    state: ViewerErrorBoundaryState,
  ): ViewerErrorBoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { hasError: false, resetKey: props.resetKey };
  }

  render() {
    if (this.state.hasError) {
      return (
        <PlaceholderCard
          destructive
          title="Preview failed to load"
          description="The 3D preview crashed while loading this file. It may be corrupt or in an unsupported format."
        />
      );
    }
    return this.props.children;
  }
}

/** The combined multi-part canvas, guarded by its own error boundary. Reused
 * for the inline box, the pop-out dialog, and the standalone window (via
 * `ViewerStage`) so all three stay visually and behaviorally identical --
 * only the wrapping height/size differs.
 *
 * `parts` now always carries EVERY combinable file (B1 "toggle-fix core"),
 * checked or not -- `PlaceholderCard` here only covers the case where there
 * is nothing combinable AT ALL (no GLB-ready files exist), which in practice
 * `ViewerTab`/`ViewerWindowPage` already guard against before ever reaching
 * this component. When parts exist but none is checked, the canvas stays
 * mounted (unmounting it would blank the WebGL context, IBL bake, and camera
 * for no reason) and a `pointer-events-none` hint overlays it instead. The
 * error boundary's `resetKey` is the checked ids only -- switching the
 * selection clears a stuck crash without remounting the boundary (see its
 * comment above). */
function MeshCanvas({
  parts,
  background,
  lighting,
  tools,
  plateSize,
  onStats,
  stats,
  fitSignal,
  apiRef,
  onPartLoaded,
  onExplodeModeChange,
  onCameraPresetClear,
  hasCoverThumbnail,
  onError,
}: {
  parts: ViewerPart[];
  background: string;
  lighting: LightingRig;
  tools: ViewerToolsState;
  plateSize: number;
  onStats: (stats: SceneStats | null) => void;
  stats: SceneStats | null;
  fitSignal: number;
  apiRef: React.MutableRefObject<ViewerApi | null>;
  /** Task 5 explode view: forwarded straight through to `ModelViewer` -- see
   * `ViewerStage`'s `handlePartLoaded` for what it does. */
  onPartLoaded: () => void;
  onExplodeModeChange: (mode: ExplodeMode) => void;
  /** R10 camera presets: forwarded to `ModelViewer`'s `OrbitPresetGuard` --
   * fires on a real user orbit so `ViewerStage` can clear `tools.
   * cameraPreset` back to `null`. */
  onCameraPresetClear: () => void;
  /** Fix wave finding 3: forwarded to `ViewerErrorBoundary` so a canvas-level
   * crash can clear the thumbnail crossfade cover in `ViewerStage`. */
  onError?: () => void;
  /** R9-D item 8: when the model has a cover thumbnail, `ViewerStage`
   * already shows it as a full-stage overlay while the GLB loads (see
   * `ViewerStage`'s thumbnail layer), so this component's own Suspense
   * fallback (the lazy-chunk import only -- GLB loads happen inside
   * `ModelViewer`'s own internal Canvas suspense and never reach here) can
   * skip the full-stage `Skeleton` and render nothing; a small corner
   * spinner in `ViewerStage` covers the "still loading" affordance instead.
   * Falls back to the old full-stage `Skeleton` when there's no thumbnail to
   * cover the gap (e.g. the pop-out window, or a model with no cover
   * image). */
  hasCoverThumbnail: boolean;
}) {
  if (parts.length === 0) {
    return (
      <PlaceholderCard
        title="Select a part to preview"
        description="Select a part in the panel to render it."
      />
    );
  }

  const visibleParts = parts.filter((part) => part.visible);

  return (
    <>
      <ViewerErrorBoundary resetKey={visibleParts.map((part) => part.id).join("|")} onError={onError}>
        <Suspense fallback={hasCoverThumbnail ? null : <Skeleton className="h-full w-full" />}>
          <ModelViewer
            parts={parts}
            background={background}
            lighting={lighting}
            tools={tools}
            plateSize={plateSize}
            onStats={onStats}
            fitSignal={fitSignal}
            apiRef={apiRef}
            onPartLoaded={onPartLoaded}
            onExplodeModeChange={onExplodeModeChange}
            onCameraPresetClear={onCameraPresetClear}
          />
        </Suspense>
      </ViewerErrorBoundary>
      {visibleParts.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50 text-sm text-muted-foreground">
          No parts selected
        </div>
      )}
      {/* "How big is this print?" -- the combined mm bounding box + triangle
          count of every visible, loaded part (`ModelViewer`'s stats-
          reporting effect), rendered over the canvas the same way the
          "No parts selected" hint above is: `pointer-events-none` so it
          never intercepts orbit-control drags, absolutely positioned within
          the stage's `relative` wrapper rather than `inset-0` since it's a
          corner chip, not a full-canvas overlay. */}
      {stats && (
        <div
          data-testid="scene-stats"
          className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-background/70 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm"
        >
          {formatStats(stats)}
        </div>
      )}
    </>
  );
}

/** AMS filament legend + "Sync colors from printer" (M8 G3), styled for the
 * narrow right-hand panel column (a vertical stack, not the old horizontal
 * bar). Rendered only when a printer is configured, so its
 * `usePrinterStatus` poll (which has no `enabled` gate) always has a real
 * id. Maps the checked parts onto the loaded trays in order, cycling if
 * there are more parts than trays. */
function AmsSync({
  printerId,
  partIds,
  onApply,
}: {
  printerId: number;
  partIds: number[];
  onApply: (colors: PartColors) => void;
}) {
  const status = usePrinterStatus(printerId);
  const trays = (status.data?.trays ?? []).filter((tray) => tray.color);
  if (trays.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Loaded filament</span>
      <div className="flex flex-wrap gap-1.5">
        {trays.map((tray) => (
          <FilamentChip key={tray.slot} color={tray.color ?? undefined} material={tray.material ?? undefined} />
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={partIds.length === 0}
        onClick={() => onApply(traysToPartColors(partIds, trays))}
        className="w-full"
      >
        Sync colors from printer
      </Button>
    </div>
  );
}

const BODY_BASE_CLASS = "flex min-h-0 flex-1 flex-col gap-3 lg:flex-row";
const INLINE_BODY_HEIGHT_CLASS = "h-[70vh] min-h-[32rem]";

export interface ViewerStageProps {
  /** The model's slug -- used only as the downloaded screenshot's filename
   * (`${slug}.png`). */
  slug: string;
  files: FileOut[];
  checkedIds: ReadonlySet<number>;
  onToggleFile: (fileId: number, checked: boolean) => void;
  /** Parts header All/None buttons -- flips every file's `visible` flag in
   * one step, the same way a single checkbox click flips one (see
   * `useViewerScene`'s `setAllChecked`). `parts` stays mounted either way. */
  onSetAllChecked: (checked: boolean) => void;
  colors: PartColors;
  onSetPartColor: (fileId: number, hex: string) => void;
  onClearPartColor: (fileId: number) => void;
  hasColors: boolean;
  onResetColors: () => void;
  preset: BackgroundPreset;
  custom: string;
  background: string;
  onPresetChange: (preset: BackgroundPreset) => void;
  onCustomChange: (custom: string) => void;
  lightingPreset: LightingPreset;
  lighting: LightingRig;
  onLightingChange: (preset: LightingPreset) => void;
  printerId: number | undefined;
  onApplyAmsColors: (colors: PartColors) => void;
  parts: ViewerPart[];
  checkedList: number[];
  onOpenWindow: (ids: number[]) => void;
  /** Shows the "New window" / "Parts in windows" pop-out buttons. False in
   * the `window` variant -- you're already in a pop-out, so re-popping is
   * noise. */
  showWindowButtons: boolean;
  showExpand: boolean;
  onExpand?: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** "inline" gets its own `h-[70vh]` since it isn't inside a sized flex
   * ancestor; "dialog" and "window" must NOT hard-code a height -- the
   * dialog's `h-[90vh]` wrapper and the window page's `h-svh` wrapper already
   * provide it, and the body row just needs to flex to fill it. */
  variant: "inline" | "dialog" | "window";
  /** View-affecting toggles (build-plate grid, auto-rotate, orthographic
   * camera, wireframe, cross-section, explode) -- see `tools.ts`. Driven by
   * the panel's View section, Section block, and Explode block below, and
   * the `F`/`R`/`W`/`G` keyboard shortcuts. */
  tools: ViewerToolsState;
  onToolsChange: (patch: Partial<ViewerToolsState>) => void;
  /** "How big is this print?" -- the combined mm bounding box + triangle
   * count of the currently visible, loaded parts, reported by `ModelViewer`
   * and rendered by `MeshCanvas`'s stats overlay chip. `null` until
   * something visible has loaded. */
  stats: SceneStats | null;
  onStats: (stats: SceneStats | null) => void;
  /** The build plate's mm side length -- single source in `useViewerScene`
   * today, so a future settings surface can override it in one place. */
  plateSize: number;
  /** A counter `ModelViewer`'s `BoundsRefitter` treats as "refit now" on
   * every change -- `useViewerScene`'s `onFit` bumps it. A counter rather
   * than a boolean since "fit" is a one-shot action: two fits in a row (the
   * `F` key pressed twice, or the ortho toggle's post-swap recovery
   * immediately after a manual fit) each need to register as a distinct
   * change, not coalesce into a no-op. */
  fitSignal: number;
  /** Bumps `fitSignal`. Wired to the "Fit view" button, the `F` key, and
   * (after `onToolsChange({ ortho: ... })`) the Orthographic toggle -- see
   * that handler's comment for why the ortho swap needs a follow-up fit. */
  onFit: () => void;
  /** The imperative surface `ModelViewer` publishes into (today:
   * `screenshot`) -- see `scene/helpers.tsx`'s `CaptureBridge`. There's no
   * prop path from the Screenshot button's click handler into a `<Canvas>`
   * child otherwise. */
  viewerApiRef: React.MutableRefObject<ViewerApi | null>;
  /** R9-D item 8: the model's cover/thumbnail image URL (`null`/`undefined`
   * when the model has none, e.g. the pop-out window today), rendered as a
   * full-stage overlay over the canvas until the first part has loaded, then
   * faded out over ~250ms (`prefers-reduced-motion` swaps instantly via
   * Tailwind's `motion-reduce:` variant -- no JS branching needed). Replaces
   * the old "blank canvas until the GLB pops in" gap with something to look
   * at. */
  coverUrl?: string | null;
  /** Fix wave finding 4: `ViewerTab`'s `MeshSection` keeps the inline stage
   * mounted while the Expand dialog's own stage is also mounted (open), so
   * without this both stages' `Shift+F` hotkey bindings would fire on one
   * keypress -- both see `document.fullscreenElement === null` (the
   * Fullscreen API is async) and both call `requestFullscreen`, so whichever
   * stage isn't visible can "win" the fullscreen request. Only the currently
   * visible/active stage should bind the hotkey; defaults to `true` since
   * every other caller (the dialog itself, the pop-out window) only ever has
   * one stage mounted at a time. */
  active?: boolean;
}

/** Strip + canvas + collapsible parts panel -- the whole redesigned viewer
 * surface. Rendered from the inline tab, the Expand dialog, and the pop-out
 * window with the SAME props (assembled by `useViewerScene`), so all three
 * are always in sync and none strips the controls away. Returns a fragment
 * rather than its own wrapping element: each caller supplies its own
 * height-bearing flex column (the inline tab a `flex flex-col gap-3` div, the
 * dialog `DialogContent`, the window page an `h-svh` column), so the body row
 * becomes a direct flex item of whichever real container it's in without an
 * extra wrapper needing its own `min-h-0 flex-1` to pass the height down.
 *
 * The appearance controls (Background, Lighting) live INSIDE the parts panel,
 * not the top strip: they're appearance settings and belong beside the
 * per-part color swatches. A consequence to accept -- collapsing the panel
 * hides them too. That's correct: the panel is THE control surface, and the
 * strip's reopen toggle brings the whole thing back. */
export function ViewerStage({
  slug,
  files,
  checkedIds,
  onToggleFile,
  onSetAllChecked,
  colors,
  onSetPartColor,
  onClearPartColor,
  hasColors,
  onResetColors,
  preset,
  custom,
  background,
  onPresetChange,
  onCustomChange,
  lightingPreset,
  lighting,
  onLightingChange,
  printerId,
  onApplyAmsColors,
  parts,
  checkedList,
  onOpenWindow,
  showWindowButtons,
  showExpand,
  onExpand,
  panelOpen,
  onTogglePanel,
  variant,
  tools,
  onToolsChange,
  stats,
  onStats,
  plateSize,
  fitSignal,
  onFit,
  viewerApiRef,
  coverUrl,
  active = true,
}: ViewerStageProps) {
  // The strip only exists to host actions. With the panel open and no
  // pop-out/expand actions to show (the window's steady state), it would be
  // an empty bar -- so render it only when it has something in it.
  const stripHasContent = !panelOpen || showWindowButtons || showExpand;

  // The ortho toggle swaps drei's default camera (perspective <->
  // orthographic), which remounts `OrbitControls` underneath it (it
  // re-derives its internal controls instance from the store's `camera`) and
  // resets the orbit target/framing -- `onFit()` right after recovers it.
  // See `ModelViewer.tsx`'s ortho-camera comment for the underlying
  // mechanism.
  const handleOrthoToggle = useCallback(() => {
    onToolsChange({ ortho: !tools.ortho });
    onFit();
  }, [onToolsChange, onFit, tools.ortho]);

  const handleAutoRotateToggle = useCallback(() => {
    onToolsChange({ autoRotate: !tools.autoRotate });
  }, [onToolsChange, tools.autoRotate]);

  const handleWireframeToggle = useCallback(() => {
    onToolsChange({ wireframe: !tools.wireframe });
  }, [onToolsChange, tools.wireframe]);

  // R10 camera presets: `ModelViewer`'s `CameraPresetTween` does the actual
  // tween/refit; this just records which preset is active so the segmented
  // control reflects it. `OrbitPresetGuard` (wired below) clears it back to
  // `null` the moment the user actually orbits.
  const handleCameraPreset = useCallback(
    (preset: CameraPreset) => onToolsChange({ cameraPreset: preset }),
    [onToolsChange],
  );
  const handleCameraPresetClear = useCallback(
    () => onToolsChange({ cameraPreset: null }),
    [onToolsChange],
  );

  const handleGridToggle = useCallback(() => {
    onToolsChange({ grid: !tools.grid });
  }, [onToolsChange, tools.grid]);

  // The explode slider leaves a nonzero offset applied to whichever parts
  // were already loaded when it moved -- a part that finishes loading LATE
  // (checked after the initial eager load, or a newly-added file) would
  // otherwise render at its un-exploded position, visibly detached from the
  // rest of the already-exploded scene. Resetting to 0 on every load keeps
  // the explode state honest: it only ever describes parts that were all
  // present when the slider last moved. A no-op during the initial eager
  // load, since `tools.explode` starts at 0 -- see `ModelViewer`'s
  // `onPartLoaded` doc comment.
  // R9-D item 8: the "GLB has loaded" half of the thumbnail crossfade --
  // `firstLoadRef` guards against `handlePartLoaded` firing again on a LATER
  // part (multi-part scenes) re-triggering the fade, since only the FIRST
  // part to load ends the "still loading" state the thumbnail covers.
  const firstLoadRef = useRef(false);
  const [modelReady, setModelReady] = useState(false);
  const handlePartLoaded = useCallback(() => {
    if (!firstLoadRef.current) {
      firstLoadRef.current = true;
      setModelReady(true);
    }
    if (tools.explode !== 0) onToolsChange({ explode: 0 });
  }, [tools.explode, onToolsChange]);

  // R9-D item 8: keeps the thumbnail `<img>` mounted for the ~250ms fade
  // (Tailwind `transition-opacity`) after `modelReady` flips, then unmounts
  // it -- a plain timer rather than an `onTransitionEnd` handler because
  // `prefers-reduced-motion` (via `motion-reduce:transition-none`) removes
  // the CSS transition entirely, which would never fire that event.
  const [thumbnailMounted, setThumbnailMounted] = useState(true);
  useEffect(() => {
    if (!modelReady) return;
    const id = window.setTimeout(() => setThumbnailMounted(false), 250);
    return () => window.clearTimeout(id);
  }, [modelReady]);

  // Fix wave finding 3: `thumbnailMounted` used to clear ONLY off
  // `modelReady`, which only ever flipped from `handlePartLoaded` (a load
  // SUCCESS). A canvas-level crash (`ViewerErrorBoundary`) rendered its
  // "Preview failed to load" fallback underneath this cover, which kept
  // painting an opaque thumbnail + spinner over it forever -- the user never
  // saw the error. `handleLoadError` drops the cover immediately (no fade,
  // unlike the success path) so the error card is never hidden behind it
  // even briefly.
  const handleLoadError = useCallback(() => {
    firstLoadRef.current = true;
    setModelReady(true);
    setThumbnailMounted(false);
  }, []);

  // Safety net for failure modes that never reach `ViewerErrorBoundary` at
  // all -- e.g. every part unchecked before the first load, or a per-part
  // load failure that `ModelViewer`'s `PartErrorBoundary` swallows locally
  // (renders `null`, never throws up to this boundary) -- either of which
  // would otherwise leave the cover mounted with no load/error signal ever
  // firing. If nothing has resolved the loading state within 8s, drop the
  // cover so the user at least sees the canvas underneath instead of a
  // frozen thumbnail.
  useEffect(() => {
    if (modelReady || !coverUrl || parts.length === 0) return;
    const id = window.setTimeout(() => setThumbnailMounted(false), 8000);
    return () => window.clearTimeout(id);
  }, [modelReady, coverUrl, parts.length]);

  // Explode classification reported by `ModelViewer` once parts load --
  // "none" until then (and for single-part / degenerate scenes), which keeps
  // the control hidden. Drives the Explode/Separate-parts block below.
  const [explodeMode, setExplodeMode] = useState<ExplodeMode>("none");

  // `viewerApiRef.current` is populated by `ModelViewer`'s `CaptureBridge`
  // only once the canvas has mounted -- `?.` guards the (brief) window
  // before that effect runs, or the empty-parts placeholder case where
  // `MeshCanvas` never renders a `ModelViewer` at all.
  const handleScreenshot = useCallback(async () => {
    const blob = await viewerApiRef.current?.screenshot();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, [viewerApiRef, slug]);

  // `F`/`R`/`W`/`G` shortcuts on the canvas wrapper -- ignored while any
  // modifier is held (so `Ctrl+F`/`Cmd+R`/etc. keep their browser-native
  // meaning instead of being hijacked). `stopPropagation` on a match keeps
  // a plain "f" from also bubbling to the ModelHeader's document-level `f`
  // favorite-toggle hotkey (R9-C item 5) -- without it, fitting the view
  // here would also toggle the model's favorite.
  const handleCanvasKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "f" || event.key === "F") {
        event.stopPropagation();
        onFit();
      } else if (event.key === "r" || event.key === "R") {
        event.stopPropagation();
        handleAutoRotateToggle();
      } else if (event.key === "w" || event.key === "W") {
        event.stopPropagation();
        handleWireframeToggle();
      } else if (event.key === "g" || event.key === "G") {
        event.stopPropagation();
        handleGridToggle();
      }
    },
    [onFit, handleAutoRotateToggle, handleWireframeToggle, handleGridToggle],
  );

  // R9-C item 5: `Shift+F` fullscreens the stage container via the
  // Fullscreen API. Document-level (via `useHotkeys`) rather than on the
  // canvas wrapper's own `onKeyDown` like the shortcuts above, since the
  // wrapper needing focus first would make this harder to discover than the
  // other viewer controls. Bound only while this component is mounted.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void stageRef.current?.requestFullscreen();
    }
  }, []);
  useHotkeys({ F: toggleFullscreen }, { enabled: active });

  return (
    <TooltipProvider>
      {stripHasContent && (
        <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-card px-3 py-2">
          {!panelOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Expand panel"
                  aria-expanded={false}
                  onClick={onTogglePanel}
                >
                  <PanelRightOpenIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Expand panel</TooltipContent>
            </Tooltip>
          )}
          {showWindowButtons && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checkedList.length === 0}
                onClick={() => onOpenWindow(checkedList)}
              >
                <ExternalLinkIcon />
                New window
              </Button>
              {checkedList.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => checkedList.forEach((id) => onOpenWindow([id]))}
                >
                  Parts in windows
                </Button>
              )}
            </>
          )}
          {showExpand && (
            <Button type="button" variant="outline" size="sm" onClick={onExpand}>
              <Maximize2Icon />
              Expand
            </Button>
          )}
        </div>
      )}

      <div className={cn(BODY_BASE_CLASS, variant === "inline" && INLINE_BODY_HEIGHT_CLASS)}>
        <div
          ref={stageRef}
          className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          tabIndex={0}
          onKeyDown={handleCanvasKeyDown}
        >
          <MeshCanvas
            parts={parts}
            background={background}
            lighting={lighting}
            tools={tools}
            plateSize={plateSize}
            onStats={onStats}
            stats={stats}
            fitSignal={fitSignal}
            apiRef={viewerApiRef}
            onPartLoaded={handlePartLoaded}
            onExplodeModeChange={setExplodeMode}
            onCameraPresetClear={handleCameraPresetClear}
            hasCoverThumbnail={Boolean(coverUrl) && parts.length > 0}
            onError={handleLoadError}
          />
          {coverUrl && parts.length > 0 && thumbnailMounted && (
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              data-testid="viewer-thumbnail"
              className={cn(
                "pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-[250ms] motion-reduce:transition-none",
                modelReady ? "opacity-0" : "opacity-100",
              )}
            />
          )}
          {coverUrl && parts.length > 0 && !modelReady && (
            <div
              data-testid="viewer-loading-indicator"
              className="pointer-events-none absolute top-2 right-2 rounded-full bg-background/70 p-1.5 backdrop-blur-sm"
            >
              <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        {panelOpen && (
          <div className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-border bg-card p-3 lg:w-72">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Parts
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {checkedList.length} of {files.length}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="Show all parts"
                  disabled={checkedList.length === files.length}
                  onClick={() => onSetAllChecked(true)}
                >
                  All
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label="None — hide all parts"
                  disabled={checkedList.length === 0}
                  onClick={() => onSetAllChecked(false)}
                >
                  None
                </Button>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Collapse panel"
                    aria-expanded={true}
                    onClick={onTogglePanel}
                  >
                    <PanelRightCloseIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse panel</TooltipContent>
              </Tooltip>
            </div>

            <div className="space-y-1">
              {files.map((file) => {
                const checked = checkedIds.has(file.id);
                const partColor = colors[file.id];
                return (
                  <div key={file.id} className={cn("flex items-center gap-2", !checked && "opacity-60")}>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => onToggleFile(file.id, next === true)}
                      aria-label={file.rel_path}
                    />
                    <label className="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring/50">
                      <FilamentChip color={partColor ?? "#cccccc"} />
                      <input
                        type="color"
                        aria-label={`Color for ${file.rel_path}`}
                        value={partColor ?? "#cccccc"}
                        onChange={(event) => onSetPartColor(file.id, event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                    <span className="min-w-0 flex-1 truncate text-sm" title={file.rel_path}>
                      {file.rel_path}
                    </span>
                    {partColor && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Reset color for ${file.rel_path}`}
                            onClick={() => onClearPartColor(file.id)}
                            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <RotateCcwIcon className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Reset color</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Appearance
              </span>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Background</span>
                <BackgroundSwatches
                  preset={preset}
                  custom={custom}
                  onPresetChange={onPresetChange}
                  onCustomChange={onCustomChange}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Lighting</span>
                <SegmentedControl
                  label="Lighting"
                  options={LIGHTING_PRESET_ORDER}
                  labels={LIGHTING_PRESET_LABELS}
                  value={lightingPreset}
                  onChange={onLightingChange}
                  className="flex-wrap"
                />
              </div>
            </div>

            {/* Camera/utility toggles + actions (Task 4), joined by
                Wireframe (Task 5) and the build-plate Grid toggle (Task 6).
                A compact icon-button row rather than labelled buttons --
                there's no room for both an icon and a label at this panel
                width, so each button carries its name via `aria-label` and a
                `Tooltip` (see `@/components/ui/tooltip`) for a hover hint
                instead of a native `title`. */}
            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                View
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={tools.grid ? "secondary" : "outline"}
                      size="icon-sm"
                      aria-pressed={tools.grid}
                      aria-label="Grid"
                      onClick={handleGridToggle}
                    >
                      <Grid3x3Icon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Grid (G)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={tools.wireframe ? "secondary" : "outline"}
                      size="icon-sm"
                      aria-pressed={tools.wireframe}
                      aria-label="Wireframe"
                      onClick={handleWireframeToggle}
                    >
                      <TriangleDashedIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Wireframe (W)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={tools.autoRotate ? "secondary" : "outline"}
                      size="icon-sm"
                      aria-pressed={tools.autoRotate}
                      aria-label="Auto-rotate"
                      onClick={handleAutoRotateToggle}
                    >
                      <RotateCwIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Auto-rotate (R)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant={tools.ortho ? "secondary" : "outline"}
                      size="icon-sm"
                      aria-pressed={tools.ortho}
                      aria-label="Orthographic camera"
                      onClick={handleOrthoToggle}
                    >
                      <BoxIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Orthographic camera</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Fit view"
                      onClick={onFit}
                    >
                      <ScanIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Fit view (F)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Screenshot"
                      onClick={handleScreenshot}
                    >
                      <CameraIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Screenshot</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Camera</span>
                <SegmentedControl
                  label="Camera preset"
                  options={CAMERA_PRESET_OPTIONS}
                  labels={CAMERA_PRESET_LABELS}
                  value={tools.cameraPreset}
                  onChange={handleCameraPreset}
                />
              </div>
            </div>

            {/* Cross-section (Task 5): the checkbox both toggles
                `section.enabled` and doubles as this block's heading (styled
                to match the uppercase muted headings above it), so
                "Section" isn't spelled out twice. Axis + sweep position only
                render while enabled -- there's nothing useful to show them
                for otherwise. */}
            <div className="flex flex-col gap-3">
              <Label className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <Checkbox
                  checked={tools.section.enabled}
                  onCheckedChange={(next) =>
                    onToolsChange({ section: { ...tools.section, enabled: next === true } })
                  }
                />
                Section
              </Label>
              {tools.section.enabled && (
                <div className="flex flex-col gap-2 pl-6">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Axis</span>
                    <SegmentedControl
                      label="Axis"
                      options={SECTION_AXIS_OPTIONS}
                      labels={SECTION_AXIS_LABELS}
                      value={tools.section.axis}
                      onChange={(axis) => onToolsChange({ section: { ...tools.section, axis } })}
                    />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    aria-label="Section position"
                    value={tools.section.t}
                    onChange={(event) =>
                      onToolsChange({ section: { ...tools.section, t: Number(event.target.value) } })
                    }
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* Explode / Separate-parts control. `ModelViewer` classifies the
                loaded parts and reports the mode up: "explode" for a genuine
                assembly (parts spread in space -> radial explode), "separate"
                for an overlapping pile of separate files (-> grid layout), and
                "none" when there's nothing to pull apart (fewer than two
                loaded parts), which hides the control. Both modes share the
                one `tools.explode` value; only the label differs. */}
            {explodeMode !== "none" && (
              <div className="flex flex-col gap-3">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {explodeControlLabel(explodeMode)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  aria-label={explodeControlLabel(explodeMode)}
                  value={tools.explode}
                  onChange={(event) => onToolsChange({ explode: Number(event.target.value) })}
                  className="w-full"
                />
              </div>
            )}

            {printerId !== undefined && (
              <AmsSync printerId={printerId} partIds={checkedList} onApply={onApplyAmsColors} />
            )}

            {hasColors && (
              <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onResetColors}>
                Reset colors
              </Button>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
