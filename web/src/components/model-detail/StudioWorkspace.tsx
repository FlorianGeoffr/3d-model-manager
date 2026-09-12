import { useMemo, useState } from "react";

import { useViewerScene } from "@/components/viewer/useViewerScene";
import { glbFiles, pickViewerFiles } from "@/components/viewer/viewable";
import { PlaceholderCard } from "@/components/viewer/ViewerStage";
import { FileRail } from "@/components/model-detail/FileRail";
import type { StudioSelection } from "@/components/model-detail/studioSelection";
import { StudioSurface } from "@/components/model-detail/StudioSurface";
import type { FileOut, ModelDetail } from "@/api/types";

/** Owns `useViewerScene` (called exactly once, here) plus the rail's current
 * selection, for one fixed glb-id-set "generation" of the model -- see
 * `StudioWorkspace` below for why it's split out like this. */
function StudioWorkspaceGeneration({
  model,
  glbable,
  others,
}: {
  model: ModelDetail;
  glbable: FileOut[];
  others: FileOut[];
}) {
  const coverUrl = model.cover_blob_hash ? `/api/blobs/${model.cover_blob_hash}/thumb?size=512` : null;
  const { stageProps } = useViewerScene({
    slug: model.slug,
    files: glbable,
    coverUrl,
    defaultAllChecked: true,
  });

  const [selection, setSelection] = useState<StudioSelection | undefined>(() =>
    glbable.length > 0 ? { type: "assembly" } : others[0] ? { type: "file", id: others[0].id } : undefined,
  );

  const slicedFiles = others.filter((file) => file.kind === "sliced");

  if (glbable.length === 0 && others.length === 0) {
    return (
      <PlaceholderCard
        title="No previewable files"
        description="Upload a mesh, CAD, or sliced file to preview it here."
      />
    );
  }

  // A file that no longer exists on this generation (shouldn't normally
  // happen -- `others` only changes when the key below remounts this whole
  // component -- but resolve defensively the same way the old `?? others[0]`
  // fallback did) falls back to the first available entry instead of a blank
  // surface.
  const resolvedSelection: StudioSelection | undefined =
    selection && (selection.type === "assembly" ? glbable.length > 0 : others.some((f) => f.id === selection.id))
      ? selection
      : glbable.length > 0
        ? { type: "assembly" }
        : others[0]
          ? { type: "file", id: others[0].id }
          : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 md:flex-row">
      <FileRail
        glbFiles={glbable}
        otherFiles={others}
        selection={resolvedSelection}
        onSelect={setSelection}
        checkedIds={stageProps.checkedIds}
        onToggleFile={stageProps.onToggleFile}
        onSetAllChecked={stageProps.onSetAllChecked}
        colors={stageProps.colors}
        onSetPartColor={stageProps.onSetPartColor}
        onClearPartColor={stageProps.onClearPartColor}
      />
      <StudioSurface
        selection={resolvedSelection}
        hasGlb={glbable.length > 0}
        otherFiles={others}
        slicedFiles={slicedFiles}
        stageProps={stageProps}
      />
    </div>
  );
}

/** Left rail + right viewing surface for the model-detail studio (Phase 4),
 * replacing the old `ViewerTab`. `useViewerScene` is owned by
 * `StudioWorkspaceGeneration` below, called exactly once for a given set of
 * ready-GLB parts -- switching which rail entry is selected only changes
 * local `selection` state, it never remounts (and so never re-fetches/
 * re-decodes) the canvas.
 *
 * Keyed on the ready-GLB id set (same trick `ViewerTab`'s `MeshSection` used)
 * because TanStack Router reuses this component instance across `$slug`
 * navigations: without the key, `useViewerScene`'s internal `checkedIds`
 * state (seeded once from `glbable[0]`) would carry model A's defaults over
 * to model B. Keying here forces a fresh mount -- and a fresh default
 * selection -- whenever the combinable file set actually changes. */
export function StudioWorkspace({ model }: { model: ModelDetail }) {
  const glbable = useMemo(() => glbFiles(model), [model]);
  const others = useMemo(
    () => pickViewerFiles(model).filter((file) => !glbable.some((glb) => glb.id === file.id)),
    [model, glbable],
  );

  return (
    <StudioWorkspaceGeneration
      key={glbable.map((file) => file.id).join(",")}
      model={model}
      glbable={glbable}
      others={others}
    />
  );
}
