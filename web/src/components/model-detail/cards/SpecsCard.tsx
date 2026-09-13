import { FileStackIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FilamentChip } from "@/components/ui/filament-chip";
import { SpecRow, type SpecItem } from "@/components/ui/spec-row";
import { SpecsTab } from "@/components/model-detail/SpecsTab";
import { modelFilaments, revisionFormats } from "@/components/model-detail/modelSpec";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import { formatDate } from "@/lib/format";
import type { ModelDetail } from "@/api/types";

/** Right-column card combining the top-level spec row + filament chips
 * (moved out of `ModelHeader` in R13a) with the per-file datasheet
 * (`SpecsTab`). */
export function SpecsCard({ model }: { model: ModelDetail }) {
  const filaments = modelFilaments(model);
  const formats = revisionFormats(model);
  const fileCount = model.current_revision?.files.length ?? 0;
  const specItems: Array<SpecItem | null> = [
    fileCount > 0
      ? { icon: <FileStackIcon />, label: `${fileCount} ${fileCount === 1 ? "file" : "files"}` }
      : null,
    formats.length > 0 ? { label: formats.map((format) => FORMAT_LABELS[format]).join(" / ") } : null,
    { label: `Updated ${formatDate(model.updated_at)}` },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Specs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SpecRow items={specItems} />
        {filaments.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="filament-strip">
            {filaments.map((filament, index) => (
              <FilamentChip
                key={`${filament.color ?? ""}-${filament.material ?? ""}-${index}`}
                color={filament.color ?? undefined}
                material={filament.material ?? undefined}
              />
            ))}
          </div>
        )}
        <SpecsTab model={model} />
      </CardContent>
    </Card>
  );
}
