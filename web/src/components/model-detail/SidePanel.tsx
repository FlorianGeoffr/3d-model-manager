import { FilesTab } from "@/components/model-detail/FilesTab";
import { NotesTab } from "@/components/model-detail/NotesTab";
import { PrintsTab } from "@/components/model-detail/PrintsTab";
import { RevisionsTab } from "@/components/model-detail/RevisionsTab";
import { SpecsTab } from "@/components/model-detail/SpecsTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ModelDetail } from "@/api/types";

/** Right-hand tabbed panel for the model-detail studio layout (Phase 4),
 * replacing the old page-wide 5-tab `Tabs` -- the 3D preview is no longer
 * one of these tabs, it's the always-visible `StudioWorkspace` to the left.
 * Sticky + independently scrollable on desktop (`lg:sticky`) so scrolling a
 * long Files/Revisions list doesn't scroll the viewer out of view; stacks
 * below the workspace on mobile via the parent grid's single-column
 * fallback. */
export function SidePanel({ model }: { model: ModelDetail }) {
  return (
    <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="revisions">Revisions</TabsTrigger>
          <TabsTrigger value="prints">Prints</TabsTrigger>
          <TabsTrigger value="specs">Specs</TabsTrigger>
        </TabsList>
        <TabsContent value="files">
          <FilesTab model={model} />
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab model={model} />
        </TabsContent>
        <TabsContent value="revisions">
          <RevisionsTab model={model} />
        </TabsContent>
        <TabsContent value="prints">
          <PrintsTab model={model} />
        </TabsContent>
        <TabsContent value="specs">
          <SpecsTab model={model} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
