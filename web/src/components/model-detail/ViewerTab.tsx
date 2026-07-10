import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ExternalLinkIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { usePrinters, usePrinterStatus } from "@/api/printers";
import { FilamentChip } from "@/components/ui/filament-chip";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { BACKGROUND_PRESET_LABELS, BACKGROUND_PRESET_ORDER, useViewerBackground, type BackgroundPreset } from "@/components/viewer/background";
import {
  encodePartColors,
  loadPartColors,
  savePartColors,
  traysToPartColors,
  type PartColors,
} from "@/components/viewer/partColors";
import { glbFiles, glbUrl, pickViewerFiles } from "@/components/viewer/viewable";
import type { FileOut, ModelDetail } from "@/api/types";

// three.js/@react-three/fiber/drei are heavy (Global Constraints "BUNDLE
// RULE") — load them only once a GLB actually needs rendering, so the main
// bundle never pays for the viewer on pages that don't visit this tab.
const ModelViewer = lazy(() => import("@/components/viewer/ModelViewer"));

function PlaceholderCard({
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
interface ViewerErrorBoundaryState {
  hasError: boolean;
}

class ViewerErrorBoundary extends Component<{ children: ReactNode }, ViewerErrorBoundaryState> {
  state: ViewerErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ViewerErrorBoundaryState {
    return { hasError: true };
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
 * for both the inline box and the pop-out dialog (via `ViewerStage`) so the
 * two stay visually and behaviorally identical -- only the wrapping
 * height/size differs. Keyed on the checked file ids so switching the
 * selection remounts the boundary, clearing any error state left over from a
 * previous selection instead of getting stuck on the fallback forever
 * (mirrors the old single-file behavior keyed on `file.id`). */
function MeshCanvas({
  parts,
  background,
}: {
  parts: { id: number; url: string; color?: string }[];
  background: string;
}) {
  if (parts.length === 0) {
    return (
      <PlaceholderCard
        title="Select a part to preview"
        description="Select a part in the panel to render it."
      />
    );
  }

  return (
    <ViewerErrorBoundary key={parts.map((part) => part.id).join("|")}>
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <ModelViewer parts={parts} background={background} />
      </Suspense>
    </ViewerErrorBoundary>
  );
}

/** Compact segmented control for the background preset -- replaces a
 * dropdown `<Select>` so the choice takes one click instead of two, and so
 * it can be driven under jsdom without mocking a Radix floating-UI open
 * state (see the inline mock comment in `ViewerTab.test.tsx`). A plain
 * `role="radiogroup"` of `role="radio"` buttons rather than the shadcn
 * `RadioGroup` primitive, which renders radio dots, not labelled segments. */
function BackgroundSegmentedControl({
  preset,
  onChange,
}: {
  preset: BackgroundPreset;
  onChange: (preset: BackgroundPreset) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Background" className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
      {BACKGROUND_PRESET_ORDER.map((option) => {
        const selected = preset === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option)}
            className={cn(
              "h-7 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {BACKGROUND_PRESET_LABELS[option]}
          </button>
        );
      })}
    </div>
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

interface ViewerStageProps {
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
  printerId: number | undefined;
  onApplyAmsColors: (colors: PartColors) => void;
  parts: { id: number; url: string; color?: string }[];
  checkedList: number[];
  onOpenWindow: (ids: number[]) => void;
  showExpand: boolean;
  onExpand?: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** "inline" gets its own `h-[70vh]` since it isn't inside a sized flex
   * ancestor; "dialog" must NOT hard-code a height -- the dialog's own
   * `h-[90vh]` wrapper already provides it, and the body row just needs to
   * flex to fill it. */
  variant: "inline" | "dialog";
}

/** Strip + canvas + collapsible parts panel -- the whole redesigned viewer
 * surface. Rendered from BOTH the inline tab and the Expand dialog with the
 * SAME props (lifted in `MeshSection`), so the two are always in sync and
 * Expand no longer strips the controls away. Returns a fragment rather than
 * its own wrapping element: the inline caller supplies a `flex flex-col
 * gap-3` wrapper and the dialog caller is `DialogContent`, itself already a
 * flex column with a fixed height -- an extra wrapping div here would need
 * its own `min-h-0 flex-1` to pass that height down, so the fragment lets
 * the body row become a direct flex item of whichever real height-bearing
 * container it's in. */
function ViewerStage({
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
  printerId,
  onApplyAmsColors,
  parts,
  checkedList,
  onOpenWindow,
  showExpand,
  onExpand,
  panelOpen,
  onTogglePanel,
  variant,
}: ViewerStageProps) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <BackgroundSegmentedControl preset={preset} onChange={onPresetChange} />
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
        <div className="flex flex-wrap items-center gap-2">
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
          {showExpand && (
            <Button type="button" variant="outline" size="sm" onClick={onExpand}>
              <Maximize2Icon />
              Expand
            </Button>
          )}
        </div>
      </div>

      <div className={cn(BODY_BASE_CLASS, variant === "inline" && INLINE_BODY_HEIGHT_CLASS)}>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <MeshCanvas parts={parts} background={background} />
        </div>

        {panelOpen && (
          <div className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-border bg-card p-3 transition-[width] motion-reduce:transition-none lg:w-72">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Parts <span className="tracking-normal normal-case">{checkedList.length}</span>
              </span>
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
                    <label className="relative inline-flex shrink-0 cursor-pointer items-center">
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
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <RotateCcwIcon className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
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

/** Multi-part combined view: a checklist of the model's ready GLB parts
 * rendered together in one scene, a slim top strip (background + window
 * pop-outs), and a collapsible right-hand parts panel whose swatch chips
 * double as the per-part recolor control. State is lifted here so the
 * inline stage and the Expand dialog share the same checked parts, colors,
 * background, and panel-collapsed state. Per-part colors (M8 G2) persist
 * per model in localStorage. */
function MeshSection({ files, slug }: { files: FileOut[]; slug: string }) {
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(() => new Set(files[0] ? [files[0].id] : []));
  const [expanded, setExpanded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [colors, setColors] = useState<PartColors>(() => loadPartColors(slug));
  const { preset, custom, color, setPreset, setCustom } = useViewerBackground();
  const printers = usePrinters();
  const printerId = printers.data?.[0]?.id;

  useEffect(() => {
    savePartColors(slug, colors);
  }, [slug, colors]);

  const parts = useMemo(
    () =>
      files
        .filter((file) => checkedIds.has(file.id))
        .map((file) => ({ id: file.id, url: glbUrl(file), color: colors[file.id] })),
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
  // (M8 G1). The window is self-contained: it re-derives everything from the
  // URL (ids + background + per-part colors), so it matches what's shown here
  // at open time. Multiple windows are cheap -- GLB urls are content-addressed.
  function openInWindow(ids: number[]) {
    const params = new URLSearchParams({ ids: ids.join(","), bg: color });
    const subset: PartColors = {};
    for (const id of ids) if (colors[id]) subset[id] = colors[id];
    const encoded = encodePartColors(subset);
    if (encoded) params.set("colors", encoded);
    window.open(`/viewer/${slug}?${params.toString()}`, "_blank", "popup=1,width=1024,height=768,noopener");
  }

  const stageProps: Omit<ViewerStageProps, "variant" | "showExpand" | "onExpand"> = {
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
    printerId,
    onApplyAmsColors: (map) => setColors((prev) => ({ ...prev, ...map })),
    parts,
    checkedList,
    onOpenWindow: openInWindow,
    panelOpen,
    onTogglePanel: () => setPanelOpen((prev) => !prev),
  };

  return (
    <>
      <div className="flex flex-col gap-3">
        <ViewerStage {...stageProps} variant="inline" showExpand onExpand={() => setExpanded(true)} />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle>3D preview</DialogTitle>
          </DialogHeader>
          <ViewerStage {...stageProps} variant="dialog" showExpand={false} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilePreview({ file }: { file: FileOut }) {
  if (file.kind === "sliced") {
    return <PlatePanel file={file} />;
  }

  if (file.format === "gcode") {
    return (
      <PlaceholderCard
        title="Plain G-code — no 3D preview"
        description="This file has no mesh geometry to render."
      />
    );
  }

  switch (file.glb_status) {
    case "pending":
      return (
        <Card className="mx-auto mt-8 max-w-md">
          <CardHeader className="items-center text-center">
            <LoaderCircleIcon className="mx-auto mb-2 size-6 animate-spin text-muted-foreground" />
            <CardTitle>Preparing preview…</CardTitle>
            {/* The app-wide SSE connection (`EventsProvider`) invalidates the
                `["models"]` query when the conversion job finishes, which
                refetches this model with the new `glb_status` — no polling
                needed here. */}
          </CardHeader>
        </Card>
      );
    case "failed":
      return (
        <PlaceholderCard
          destructive
          title="Preview failed"
          description="Couldn't generate a 3D preview for this file."
        />
      );
    case "unsupported":
    default:
      return (
        <PlaceholderCard
          title="No 3D preview"
          description="This file format doesn't support in-browser previewing."
        />
      );
  }
}

export function ViewerTab({ model }: { model: ModelDetail }) {
  const glbable = useMemo(() => glbFiles(model), [model]);
  const others = useMemo(
    () => pickViewerFiles(model).filter((file) => !glbable.some((glb) => glb.id === file.id)),
    [model, glbable],
  );

  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);
  const selectedFile = others.find((file) => file.id === selectedId) ?? others[0];

  if (glbable.length === 0 && !selectedFile) {
    return (
      <PlaceholderCard
        title="No previewable files"
        description="Upload a mesh, CAD, or sliced file to preview it here."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Keying on the ready-GLB id set makes `MeshSection` remount -- and
          so re-derive its first-part-checked default -- whenever the file set
          changes. TanStack Router reuses this component instance across
          `$slug` navigations (no route-level key), so without this, checked
          part ids from a previous model would carry over to the next one,
          leaving every box unchecked. */}
      {glbable.length > 0 && (
        <MeshSection key={glbable.map((file) => file.id).join(",")} files={glbable} slug={model.slug} />
      )}

      {selectedFile && (
        <div className="space-y-4">
          <Select value={String(selectedFile.id)} onValueChange={(next) => setSelectedId(Number(next))}>
            <SelectTrigger aria-label="File">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {others.map((file) => (
                <SelectItem key={file.id} value={String(file.id)}>
                  {file.rel_path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <FilePreview file={selectedFile} />
        </div>
      )}
    </div>
  );
}
