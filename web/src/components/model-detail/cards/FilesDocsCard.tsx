import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FilesTab } from "@/components/model-detail/FilesTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ModelDetail } from "@/api/types";

/** Right-column card wrapping `FilesTab` behind an inner "Files"/"Docs"
 * split (R13a). Doc file kinds don't exist yet -- that's R13c -- so "Docs"
 * is a placeholder with a fixed zero count rather than a real tab body. */
export function FilesDocsCard({ model }: { model: ModelDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="files">
          <TabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="docs">Docs (0)</TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <FilesTab model={model} />
          </TabsContent>
          <TabsContent value="docs">
            <p className="py-8 text-center text-sm text-muted-foreground">
              Documentation files land in R13c.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
