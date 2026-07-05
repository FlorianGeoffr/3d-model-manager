import { getRouteApi } from "@tanstack/react-router";

import { useModel } from "@/api/library";
import { FilesTab } from "@/components/model-detail/FilesTab";
import { ModelHeader } from "@/components/model-detail/ModelHeader";
import { NotesTab } from "@/components/model-detail/NotesTab";
import { RevisionsTab } from "@/components/model-detail/RevisionsTab";
import { ViewerTab } from "@/components/model-detail/ViewerTab";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/api/client";

const routeApi = getRouteApi("/authenticated/models/$slug");

export function ModelDetailPage() {
  const { slug } = routeApi.useParams();
  const modelQuery = useModel(slug);

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
      <ModelHeader model={model} />
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="viewer">3D View</TabsTrigger>
          <TabsTrigger value="revisions">Revisions</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="files">
          <FilesTab model={model} />
        </TabsContent>
        <TabsContent value="viewer">
          <ViewerTab />
        </TabsContent>
        <TabsContent value="revisions">
          <RevisionsTab model={model} />
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab model={model} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
