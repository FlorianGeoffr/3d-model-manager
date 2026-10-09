import { lazy, Suspense } from "react";
import { ArrowLeftIcon, LayersIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { useReprocessFile } from "@/api/library";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { PlaceholderCard, ViewerStage, type ViewerStageProps } from "@/components/viewer/ViewerStage";
import type { StudioSelection } from "@/components/model-detail/studioSelection";
import type { FileOut } from "@/api/types";

const GcodePreview = lazy(() => import("@/components/viewer/GcodePreview"));

type StageProps = Omit<ViewerStageProps, "variant" | "showWindowButtons">;

function FileState({
  file,
  modelSlug,
  projectId,
}: {
  file: FileOut;
  modelSlug?: string;
  projectId?: number | null;
}) {
  const reprocess = useReprocessFile(modelSlug);

  if (file.kind === "sliced") {
    return <PlatePanel file={file} modelSlug={modelSlug} projectId={projectId} />;
  }

  if (file.format === "gcode") {
    return (
      <div className="mx-auto w-full max-w-4xl p-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <LayersIcon className="size-3.5 text-primary" />
          <span>G-code toolpath preview — {file.rel_path}</span>
        </div>
        <Suspense
          fallback={
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-5 animate-spin" />
              Loading g-code preview…
            </div>
          }
        >
          <GcodePreview fileId={file.id} />
        </Suspense>
      </div>
    );
  }

  const isImage =
    file.kind === "image" ||
    ["png", "jpg", "jpeg", "webp", "gif"].includes(file.format.toLowerCase());
  if (isImage) {
    const imageUrl = file.thumb_ready
      ? `/api/blobs/${file.blob_hash}/thumb?size=1024`
      : `/api/files/${file.id}/download?inline=1`;
    return (
      <div className="flex h-full min-h-[420px] w-full flex-col items-center justify-center p-6">
        <div className="relative max-h-[600px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30 p-2 shadow-xs">
          <img
            src={imageUrl}
            alt={file.rel_path}
            className="max-h-[560px] max-w-full rounded-lg object-contain"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              const inlineFallback = `/api/files/${file.id}/download?inline=1`;
              if (target.src !== inlineFallback) {
                target.src = inlineFallback;
              }
            }}
          />
        </div>
        <span className="mt-2 text-xs text-muted-foreground">{file.rel_path}</span>
      </div>
    );
  }


  switch (file.glb_status) {
    case "pending":
      return (
        <Card className="mx-auto mt-8 max-w-md">
          <CardHeader className="items-center text-center">
            <LoaderCircleIcon className="mx-auto mb-2 size-6 animate-spin text-muted-foreground" />
            <CardTitle>Preparing preview…</CardTitle>
            <CardDescription>
              Generating 3D preview in the background.
            </CardDescription>
            <div className="mt-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={() =>
                  reprocess.mutate(file.id, {
                    onSuccess: () => toast.success("Reprocessing restarted"),
                    onError: () => toast.error("Failed to start reprocessing"),
                  })
                }
                disabled={reprocess.isPending}
              >
                <RefreshCwIcon
                  className={`mr-1.5 size-3.5 ${reprocess.isPending ? "animate-spin" : ""}`}
                />
                Force reprocess
              </Button>
            </div>
          </CardHeader>
        </Card>
      );
    case "failed":
      return (
        <PlaceholderCard
          destructive
          title="Preview failed"
          description={
            file.glb_error ? (
              <div className="space-y-2">
                <p>Couldn't generate a 3D preview for this file.</p>
                <div className="max-h-36 overflow-y-auto rounded bg-destructive/10 p-2 text-left font-mono text-xs text-destructive break-words">
                  {file.glb_error}
                </div>
              </div>
            ) : (
              "Couldn't generate a 3D preview for this file."
            )
          }
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                reprocess.mutate(file.id, {
                  onSuccess: () => toast.success("Reprocessing started"),
                  onError: () => toast.error("Failed to start reprocessing"),
                })
              }
              disabled={reprocess.isPending}
            >
              <RefreshCwIcon
                className={`mr-2 size-4 ${reprocess.isPending ? "animate-spin" : ""}`}
              />
              Retry processing
            </Button>
          }
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

/** The studio's viewing surface (R13a re-chrome): a pure switch on the rail's
 * current selection. The assembly view reuses the exact `ViewerStage` the
 * old `MeshSection` rendered (pop-out window buttons kept). The sliced-plate
 * strip that used to render underneath it here has moved to the right
 * column's `GcodeProfilesCard` (still `PlatePanel`, just relocated) -- this
 * surface no longer needs `slicedFiles` at all. */
export function StudioSurface({
  selection,
  hasGlb,
  otherFiles,
  stageProps,
  onSelectAssembly,
  modelSlug,
  projectId,
}: {
  selection: StudioSelection | undefined;
  hasGlb: boolean;
  otherFiles: FileOut[];
  stageProps: StageProps;
  /** R13c "View in 3D" hand-off: returns the surface to the combined
   * assembly view. Only rendered as a chip when a single file is selected
   * AND the model actually has an assembly to go back to. */
  onSelectAssembly: () => void;
  modelSlug?: string;
  projectId?: number | null;
}) {
  if (!selection) {
    return (
      <PlaceholderCard
        title="No previewable files"
        description="Upload a mesh, CAD, or sliced file to preview it here."
      />
    );
  }

  if (selection.type === "assembly" && hasGlb) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <ViewerStage {...stageProps} variant="inline" showWindowButtons />
      </div>
    );
  }

  const file = otherFiles.find((candidate) => selection.type === "file" && candidate.id === selection.id);
  if (!file) {
    return (
      <PlaceholderCard
        title="No previewable files"
        description="Upload a mesh, CAD, or sliced file to preview it here."
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {hasGlb && (
        <button
          type="button"
          onClick={onSelectAssembly}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back to assembly
        </button>
      )}
      <FileState file={file} modelSlug={modelSlug} projectId={projectId} />
    </div>
  );
}
