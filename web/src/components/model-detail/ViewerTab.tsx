import { useMemo, useState } from "react";
import { LoaderCircleIcon } from "lucide-react";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { PlaceholderCard, ViewerStage } from "@/components/viewer/ViewerStage";
import { useViewerScene } from "@/components/viewer/useViewerScene";
import { glbFiles, pickViewerFiles } from "@/components/viewer/viewable";
import type { FileOut, ModelDetail } from "@/api/types";

/** Multi-part combined view: a checklist of the model's ready GLB parts
 * rendered together in one scene, plus the collapsible right-hand panel that
 * holds the parts checklist and the appearance controls (Background,
 * Lighting). `useViewerScene` owns the state so the inline stage and the
 * Expand dialog share the same checked parts, colors, background, lighting,
 * and panel-collapsed state -- and so the standalone pop-out window can reuse
 * the exact same stage. Per-part colors (M8 G2) persist per model in
 * localStorage. */
function MeshSection({
  files,
  slug,
  coverUrl,
}: {
  files: FileOut[];
  slug: string;
  coverUrl: string | null;
}) {
  const { stageProps } = useViewerScene({ slug, files, coverUrl });
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div className="flex flex-col gap-3">
        <ViewerStage
          {...stageProps}
          variant="inline"
          showWindowButtons
          showExpand
          onExpand={() => setExpanded(true)}
          // Fix wave finding 4: this stage stays mounted while the Expand
          // dialog is open, so it must give up its Shift+F binding to the
          // dialog's own (visible) stage below.
          active={!expanded}
        />
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle>3D preview</DialogTitle>
          </DialogHeader>
          <ViewerStage {...stageProps} variant="dialog" showWindowButtons showExpand={false} />
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
        <MeshSection
          key={glbable.map((file) => file.id).join(",")}
          files={glbable}
          slug={model.slug}
          coverUrl={model.cover_blob_hash ? `/api/blobs/${model.cover_blob_hash}/thumb?size=512` : null}
        />
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
