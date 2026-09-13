import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FilesTab } from "@/components/model-detail/FilesTab";
import type { FileOut, ModelDetail } from "@/api/types";

/** Right-column card wrapping `FilesTab` (R13a). Doc file kinds don't exist
 * yet -- that's a future revision -- so this renders the Files body only for
 * now rather than a "Docs (0)" tab with a dead, permanently-empty second
 * pane; the Tabs/Docs-placeholder pair from the original re-chrome is gone,
 * not just hidden, per the "no dead controls" rule (`FilesTab.tsx`'s own
 * per-row actions are the only controls this card exposes). */
export function FilesDocsCard({
  model,
  onViewIn3D,
}: {
  model: ModelDetail;
  onViewIn3D?: (file: FileOut) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
      </CardHeader>
      <CardContent>
        <FilesTab model={model} onViewIn3D={onViewIn3D} />
      </CardContent>
    </Card>
  );
}
