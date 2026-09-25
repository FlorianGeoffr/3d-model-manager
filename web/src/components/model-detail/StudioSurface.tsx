import { lazy, Suspense } from "react";
import { ArrowLeftIcon, LayersIcon, LoaderCircleIcon } from "lucide-react";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
