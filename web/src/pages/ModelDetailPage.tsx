import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { useModel } from "@/api/library";
import { ArchivedBanner } from "@/components/model-detail/ArchivedBanner";
import { DetailLayout } from "@/components/model-detail/DetailLayout";
import { ModelHeader } from "@/components/model-detail/ModelHeader";
import { RelatedModels } from "@/components/model-detail/RelatedModels";
import { StudioWorkspace } from "@/components/model-detail/StudioWorkspace";
import { useStudioSelection } from "@/components/model-detail/studioSelection";
import { DescriptionCard } from "@/components/model-detail/cards/DescriptionCard";
import { FilesDocsCard } from "@/components/model-detail/cards/FilesDocsCard";
import { GcodeProfilesCard } from "@/components/model-detail/cards/GcodeProfilesCard";
import { NotesCard } from "@/components/model-detail/cards/NotesCard";
import { PrintHistoryCard } from "@/components/model-detail/cards/PrintHistoryCard";
import { PrintTipsCard } from "@/components/model-detail/cards/PrintTipsCard";
import { RevisionsCard } from "@/components/model-detail/cards/RevisionsCard";
import { SpecsCard } from "@/components/model-detail/cards/SpecsCard";
import { TagsLinksCard } from "@/components/model-detail/cards/TagsLinksCard";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/api/client";

const routeApi = getRouteApi("/authenticated/models/$slug");

export function ModelDetailPage() {
  const { slug } = routeApi.useParams();
  const modelQuery = useModel(slug);
  // Per-visit UI state only -- not persisted. Gates metadata editing
  // (name/description/tags/archive) behind an explicit toggle so a stray
  // click can't silently mutate a model.
  const [editMode, setEditMode] = useState(false);
  // The "Move / copy…" trigger lives in `ModelHeader`'s overflow menu, but
  // the dialog it opens (`StorageLocationBar`) now renders inside
  // `TagsLinksCard` -- lifted here so both can share the same controlled
  // `open` state.
  const [relocateOpen, setRelocateOpen] = useState(false);
  // The route component stays mounted when only `$slug` changes (e.g. the
  // upcoming related-models strip links detail -> detail), so drop the gate
  // when navigating to a different model: landing on it already in edit
  // mode -- possibly with a stale open InlineEdit draft, which deliberately
  // never resets while editing -- would defeat the whole gate. Render-time
  // state adjustment (per React's "adjusting state when a prop changes")
  // instead of an effect, so the new model never paints editable.
  const [gateSlug, setGateSlug] = useState(slug);
  if (slug !== gateSlug) {
    setGateSlug(slug);
    setEditMode(false);
    setRelocateOpen(false);
  }
  // Called unconditionally (rules of hooks) ahead of the loading/error early
  // returns below -- guards `model` being absent internally instead. Owns
  // the studio surface's selection here (not inside `StudioWorkspace`) so
  // `FilesDocsCard`'s per-row "View in 3D" action can reach it too.
  const studio = useStudioSelection(modelQuery.data);

  if (modelQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (modelQuery.isError) {
    const message =
      modelQuery.error instanceof ApiError ? modelQuery.error.detail : "Could not load this model.";
    return <p className="text-sm text-destructive">{message}</p>;
  }

  const model = modelQuery.data;
  if (!model) return null;

  return (
    <div className="space-y-6">
      <ModelHeader
        model={model}
        editMode={editMode}
        onToggleEditMode={() => setEditMode((prev) => !prev)}
        onOpenRelocate={() => setRelocateOpen(true)}
      />
      <ArchivedBanner model={model} />
      <DetailLayout
        left={
          <>
            <StudioWorkspace
              model={model}
              glbable={studio.glbable}
              others={studio.others}
              selection={studio.selection}
              onSelectAssembly={studio.onSelectAssembly}
            />
            <DescriptionCard model={model} editMode={editMode} />
            <TagsLinksCard
              model={model}
              editMode={editMode}
              relocateOpen={relocateOpen}
              onRelocateOpenChange={setRelocateOpen}
            />
            <RelatedModels model={model} />
          </>
        }
        right={
          <>
            <GcodeProfilesCard model={model} />
            <PrintHistoryCard model={model} />
            <FilesDocsCard model={model} onViewIn3D={studio.onViewIn3D} />
            <RevisionsCard model={model} />
            <NotesCard model={model} />
            <PrintTipsCard model={model} />
            <SpecsCard model={model} />
          </>
        }
      />
    </div>
  );
}
