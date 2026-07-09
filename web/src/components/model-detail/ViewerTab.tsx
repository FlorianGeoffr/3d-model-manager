import { Component, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { ExternalLinkIcon, LoaderCircleIcon, Maximize2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { BACKGROUND_PRESET_LABELS, BACKGROUND_PRESET_ORDER, useViewerBackground, type BackgroundPreset } from "@/components/viewer/background";
import {
  encodePartColors,
  loadPartColors,
  savePartColors,
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
 * for both the inline box and the pop-out dialog so the two stay visually
 * and behaviorally identical -- only the wrapping height/size differs.
 * Keyed on the checked file ids so switching the selection remounts the
 * boundary, clearing any error state left over from a previous selection
 * instead of getting stuck on the fallback forever (mirrors the old
 * single-file behavior keyed on `file.id`). */
function MeshCanvas({
  parts,
  background,
}: {
  parts: { id: number; url: string; color?: string }[];
  background: string;
}) {
  if (parts.length === 0) {
    return (
      <PlaceholderCard title="Select a part to preview" description="Check at least one part above to render it." />
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

function BackgroundPicker({
  preset,
  custom,
  onPresetChange,
  onCustomChange,
}: {
  preset: BackgroundPreset;
  custom: string;
  onPresetChange: (preset: BackgroundPreset) => void;
  onCustomChange: (custom: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="viewer-background" className="font-normal text-muted-foreground">
        Background
      </Label>
      <Select value={preset} onValueChange={(next) => onPresetChange(next as BackgroundPreset)}>
        <SelectTrigger id="viewer-background" aria-label="Background" size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {BACKGROUND_PRESET_ORDER.map((option) => (
            <SelectItem key={option} value={option}>
              {BACKGROUND_PRESET_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  );
}

/** Multi-part combined view: a checklist of the model's ready GLB parts
 * rendered together in one scene, a prominent toolbar (background + recolor +
 * window pop-outs), and an "Expand" pop-out. State is lifted here so the
 * inline box and the pop-out dialog share the same checked parts, colors, and
 * background. Per-part colors (M8 G2) persist per model in localStorage. */
function MeshSection({ files, slug }: { files: FileOut[]; slug: string }) {
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<number>>(() => new Set(files[0] ? [files[0].id] : []));
  const [expanded, setExpanded] = useState(false);
  const [colors, setColors] = useState<PartColors>(() => loadPartColors(slug));
  const { preset, custom, color, setPreset, setCustom } = useViewerBackground();

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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <BackgroundPicker preset={preset} custom={custom} onPresetChange={setPreset} onCustomChange={setCustom} />
        <div className="flex flex-wrap items-center gap-2">
          {hasColors && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setColors({})}>
              Reset colors
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={checkedList.length === 0}
            onClick={() => openInWindow(checkedList)}
          >
            <ExternalLinkIcon />
            New window
          </Button>
          {checkedList.length > 1 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => checkedList.forEach((id) => openInWindow([id]))}
            >
              Parts in windows
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setExpanded(true)}>
            <Maximize2Icon />
            Expand
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        {files.map((file) => {
          const checked = checkedIds.has(file.id);
          const partColor = colors[file.id];
          return (
            <div key={file.id} className="flex items-center gap-2">
              <Label className="flex flex-1 items-center gap-2 font-normal">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) => toggleFile(file.id, next === true)}
                />
                {file.rel_path}
              </Label>
              {checked && (
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    aria-label={`Color for ${file.rel_path}`}
                    value={partColor ?? "#cccccc"}
                    onChange={(event) => setPartColor(file.id, event.target.value)}
                    className="h-6 w-8 rounded-md border border-input bg-transparent p-0.5"
                  />
                  {partColor && (
                    <button
                      type="button"
                      aria-label={`Reset color for ${file.rel_path}`}
                      onClick={() => clearPartColor(file.id)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="h-[28rem] overflow-hidden rounded-lg border border-border">
        <MeshCanvas parts={parts} background={color} />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle>3D preview</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
            <MeshCanvas parts={parts} background={color} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
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
