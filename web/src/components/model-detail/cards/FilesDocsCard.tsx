import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DocsTab } from "@/components/model-detail/DocsTab";
import { FilesTab } from "@/components/model-detail/FilesTab";
import type { FileOut, ModelDetail } from "@/api/types";

/** Right-column card wrapping `FilesTab`/`DocsTab` (R13a introduced the
 * card with Files only; R13c adds the doc `BlobKind` and re-enables the
 * Files | Docs tab split with real counts on each label. `onViewIn3D` only
 * ever applies to `FilesTab` -- docs are never studio-viewable. */
export function FilesDocsCard({
  model,
  onViewIn3D,
}: {
  model: ModelDetail;
  onViewIn3D?: (file: FileOut) => void;
}) {
  const files = model.current_revision?.files ?? [];
  const fileCount = files.filter((file) => file.kind !== "doc").length;
  const docCount = files.filter((file) => file.kind === "doc").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="files">
          <TabsList>
            <TabsTrigger value="files">Files ({fileCount})</TabsTrigger>
            <TabsTrigger value="docs">Docs ({docCount})</TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <FilesTab model={model} onViewIn3D={onViewIn3D} />
          </TabsContent>
          <TabsContent value="docs">
            <DocsTab model={model} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
