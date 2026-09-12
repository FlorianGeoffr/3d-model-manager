import { LoaderCircleIcon } from "lucide-react";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { PlaceholderCard, ViewerStage, type ViewerStageProps } from "@/components/viewer/ViewerStage";
import type { StudioSelection } from "@/components/model-detail/FileRail";
import type { FileOut } from "@/api/types";

type StageProps = Omit<ViewerStageProps, "variant" | "showExpand" | "onExpand" | "showWindowButtons">;

function FileState({ file }: { file: FileOut }) {
  if (file.kind === "sliced") return <PlatePanel file={file} />;

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

/** The right-of-rail viewing surface (Phase 4 studio): a pure switch on the
 * rail's current selection. The assembly view reuses the exact `ViewerStage`
 * the old `MeshSection` rendered (pop-out window buttons kept, Expand
 * dropped -- there's no dialog to expand into anymore, the studio layout IS
 * the expanded view) and, when the model ALSO has sliced files, shows a
 * compact plate-card strip underneath so neither view hides the other. */
export function StudioSurface({
  selection,
  hasGlb,
  otherFiles,
  slicedFiles,
  stageProps,
}: {
  selection: StudioSelection | undefined;
  hasGlb: boolean;
  otherFiles: FileOut[];
  slicedFiles: FileOut[];
  stageProps: StageProps;
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
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <ViewerStage {...stageProps} variant="inline" showWindowButtons showExpand={false} />
        {slicedFiles.length > 0 && (
          <div className="space-y-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Sliced plates
            </span>
            <div className="flex gap-4 overflow-x-auto">
              {slicedFiles.map((file) => (
                <PlatePanel key={file.id} file={file} compact />
              ))}
            </div>
          </div>
        )}
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
    <div className="min-w-0 flex-1">
      <FileState file={file} />
    </div>
  );
}
