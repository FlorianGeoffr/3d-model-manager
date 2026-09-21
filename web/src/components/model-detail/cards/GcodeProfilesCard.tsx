import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlatePanel } from "@/components/model-detail/PlatePanel";
import type { ModelDetail } from "@/api/types";

/** Right-column card for sliced-plate files (R13a) -- the sliced-plate strip
 * that used to live under the viewer in `StudioSurface` now lives here, one
 * `PlatePanel` per sliced file on the current revision. Renders nothing when
 * the model has no sliced files, same "no dead controls" posture as every
 * other card here. */
export function GcodeProfilesCard({ model }: { model: ModelDetail }) {
  const slicedFiles = (model.current_revision?.files ?? []).filter((file) => file.kind === "sliced");
  if (slicedFiles.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>G-code profiles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {slicedFiles.map((file) => (
          <PlatePanel key={file.id} file={file} modelSlug={model.slug} />
        ))}
      </CardContent>
    </Card>
  );
}
