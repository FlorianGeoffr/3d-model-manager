import { Component, Suspense, lazy, useCallback, type KeyboardEvent, type ReactNode } from "react";
import {
  BoxIcon,
  CameraIcon,
  ExternalLinkIcon,
  Maximize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ScanIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePrinterStatus } from "@/api/printers";
import { FilamentChip } from "@/components/ui/filament-chip";
import { SegmentedControl } from "@/components/viewer/SegmentedControl";
import {
  BACKGROUND_PRESET_LABELS,
  BACKGROUND_PRESET_ORDER,
  type BackgroundPreset,
} from "@/components/viewer/background";
import {
  LIGHTING_PRESET_LABELS,
  LIGHTING_PRESET_ORDER,
  type LightingPreset,
  type LightingRig,
} from "@/components/viewer/lighting";
import { traysToPartColors, type PartColors } from "@/components/viewer/partColors";
import {
  formatStats,
  type SceneStats,
  type ViewerApi,
  type ViewerToolsState,
} from "@/components/viewer/tools";
import type { ViewerPart } from "@/components/viewer/viewable";
import type { FileOut } from "@/api/types";

// three.js/@react-three/fiber/drei are heavy (Global Constraints "BUNDLE
// RULE") — load them only once a GLB actually needs rendering, so the main
// bundle never pays for the viewer on pages that don't render this stage.
const ModelViewer = lazy(() => import("@/components/viewer/ModelViewer"));

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
      <ViewerErrorBoundary resetKey={visibleParts.map((part) => part.id).join("|")}>
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
          <ModelViewer
            parts={parts}
            background={background}
            lighting={lighting}
            tools={tools}
            plateSize={plateSize}
            onStats={onStats}
            fitSignal={fitSignal}
            apiRef={apiRef}
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
   * camera today; wireframe/section/explode land on later tasks in this
   * branch) -- see `tools.ts`. Driven by the panel's View section below and
   * the `R` keyboard shortcut. */
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

  // `F`/`R` shortcuts on the canvas wrapper -- ignored while any modifier is
  // held (so `Ctrl+F`/`Cmd+R`/etc. keep their browser-native meaning instead
  // of being hijacked). `G`/`W` arrive with the grid-toggle/wireframe
  // features that land later on this branch.
  const handleCanvasKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key === "f" || event.key === "F") {
        onFit();
      } else if (event.key === "r" || event.key === "R") {
        handleAutoRotateToggle();
      }
    },
    [onFit, handleAutoRotateToggle],
  );

  return (
    <>
      {stripHasContent && (
        <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg border border-border bg-card px-3 py-2">
          {!panelOpen && (
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
          />
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
              </div>
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
                      <button
                        type="button"
                        aria-label={`Reset color for ${file.rel_path}`}
                        onClick={() => onClearPartColor(file.id)}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <RotateCcwIcon className="size-3.5" />
                      </button>
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
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl
                    label="Background"
                    options={BACKGROUND_PRESET_ORDER}
                    labels={BACKGROUND_PRESET_LABELS}
                    value={preset}
                    onChange={onPresetChange}
                    className="flex-wrap"
                  />
                  {preset === "custom" && (
                    <input
                      type="color"
                      aria-label="Custom background color"
                      value={custom}
                      onChange={(event) => onCustomChange(event.target.value)}
                      className="h-7 w-10 rounded-md border border-input bg-transparent p-0.5"
                    />
                  )}
                </div>
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

            {/* Camera/utility toggles + actions (Task 4). Wireframe/section/
                explode join this row on Task 5; the grid toggle and a
                regroup land on Task 6. A compact icon-button row rather than
                labelled buttons -- there's no room for both an icon and a
                label at this panel width, so each button carries its name
                via `aria-label` (and `title` for a hover tooltip) instead. */}
            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                View
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  type="button"
                  variant={tools.autoRotate ? "secondary" : "outline"}
                  size="icon-sm"
                  aria-pressed={tools.autoRotate}
                  aria-label="Auto-rotate"
                  title="Auto-rotate (R)"
                  onClick={handleAutoRotateToggle}
                >
                  <RotateCwIcon />
                </Button>
                <Button
                  type="button"
                  variant={tools.ortho ? "secondary" : "outline"}
                  size="icon-sm"
                  aria-pressed={tools.ortho}
                  aria-label="Orthographic camera"
                  title="Orthographic camera"
                  onClick={handleOrthoToggle}
                >
                  <BoxIcon />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Fit view"
                  title="Fit view (F)"
                  onClick={onFit}
                >
                  <ScanIcon />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Screenshot"
                  title="Screenshot"
                  onClick={handleScreenshot}
                >
                  <CameraIcon />
                </Button>
              </div>
            </div>

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
    </>
  );
}
