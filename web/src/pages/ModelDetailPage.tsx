import { useState } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { useModel } from "@/api/library";
import { FilesTab } from "@/components/model-detail/FilesTab";
import { ModelHeader } from "@/components/model-detail/ModelHeader";
import { NotesTab } from "@/components/model-detail/NotesTab";
import { PrintsTab } from "@/components/model-detail/PrintsTab";
import { RelatedModels } from "@/components/model-detail/RelatedModels";
import { RevisionsTab } from "@/components/model-detail/RevisionsTab";
import { ViewerTab } from "@/components/model-detail/ViewerTab";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/api/client";

const routeApi = getRouteApi("/authenticated/models/$slug");

export function ModelDetailPage() {
  const { slug } = routeApi.useParams();
  const modelQuery = useModel(slug);
  // Per-visit UI state only -- not persisted. Gates metadata editing
  // (name/description/tags/archive) behind an explicit toggle so a stray
  // click can't silently mutate a model.
  const [editMode, setEditMode] = useState(false);
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
  }

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
      <ModelHeader model={model} editMode={editMode} onToggleEditMode={() => setEditMode((prev) => !prev)} />
      <RelatedModels model={model} />
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="viewer">3D View</TabsTrigger>
          <TabsTrigger value="revisions">Revisions</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="prints">Prints</TabsTrigger>
        </TabsList>
        <TabsContent value="files">
          <FilesTab model={model} />
        </TabsContent>
        <TabsContent value="viewer">
          <ViewerTab model={model} />
        </TabsContent>
        <TabsContent value="revisions">
          <RevisionsTab model={model} />
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab model={model} />
        </TabsContent>
        <TabsContent value="prints">
          <PrintsTab model={model} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
