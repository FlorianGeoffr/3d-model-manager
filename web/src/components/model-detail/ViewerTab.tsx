import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { LoaderCircleIcon } from "lucide-react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import { glbUrl, pickViewerFiles } from "@/components/viewer/viewable";
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
    case "ok":
      return (
        <div className="h-[28rem] overflow-hidden rounded-lg border border-border">
          {/* Keyed on the file's id so switching to a different file remounts
              the boundary, clearing any error state left over from a
              previous file's bad GLB instead of getting stuck on the
              fallback forever. */}
          <ViewerErrorBoundary key={file.id}>
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
              <ModelViewer url={glbUrl(file)} />
            </Suspense>
          </ViewerErrorBoundary>
        </div>
      );
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
  const files = pickViewerFiles(model);
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined);
  const selectedFile = files.find((file) => file.id === selectedId) ?? files[0];

  if (!selectedFile) {
    return (
      <PlaceholderCard
        title="No previewable files"
        description="Upload a mesh, CAD, or sliced file to preview it here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <Select value={String(selectedFile.id)} onValueChange={(next) => setSelectedId(Number(next))}>
        <SelectTrigger aria-label="File">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {files.map((file) => (
            <SelectItem key={file.id} value={String(file.id)}>
              {file.rel_path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilePreview file={selectedFile} />
    </div>
  );
}
