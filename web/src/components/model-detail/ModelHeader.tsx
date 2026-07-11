import { useNavigate } from "@tanstack/react-router";
import { FileStackIcon, PencilIcon } from "lucide-react";

import { useArchiveModel, usePatchModel } from "@/api/library";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineEdit } from "@/components/InlineEdit";
import { modelFilaments, revisionFormats } from "@/components/model-detail/modelSpec";
import { ProvenanceBlock } from "@/components/model-detail/ProvenanceBlock";
import { StorageLocationBar } from "@/components/model-detail/StorageLocationBar";
import { TagEditor } from "@/components/model-detail/TagEditor";
import { Button } from "@/components/ui/button";
import { FilamentChip } from "@/components/ui/filament-chip";
import { SpecRow, type SpecItem } from "@/components/ui/spec-row";
import { formatDate } from "@/lib/format";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import type { ModelDetail } from "@/api/types";

export function ModelHeader({
  model,
  editMode,
  onToggleEditMode,
}: {
  model: ModelDetail;
  editMode: boolean;
  onToggleEditMode: () => void;
}) {
  const navigate = useNavigate();
  const patchModel = usePatchModel(model.slug);
  const archiveModel = useArchiveModel(model.slug);

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
    <div className="space-y-3 border-b border-border pb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {editMode ? (
            <>
              <InlineEdit
                value={model.name}
                aria-label="name"
                onSave={(name) => {
                  if (name) patchModel.mutate({ name });
                }}
                displayClassName="text-2xl font-semibold"
                className="text-2xl font-semibold"
              />
              <InlineEdit
                value={model.description ?? ""}
                placeholder="Add a description…"
                aria-label="description"
                multiline
                onSave={(description) => patchModel.mutate({ description: description || null })}
                displayClassName="text-sm text-muted-foreground"
              />
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">{model.name}</h1>
              {model.description && (
                <p className="text-sm text-muted-foreground">{model.description}</p>
              )}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" onClick={onToggleEditMode}>
            <PencilIcon />
            {editMode ? "Done" : "Edit"}
          </Button>
          {editMode && (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  Archive
                </Button>
              }
              title={`Archive "${model.name}"?`}
              description="Archived models are hidden from the library by default. This does not delete files."
              confirmLabel="Archive"
              destructive
              onConfirm={() =>
                archiveModel.mutate(undefined, {
                  onSuccess: () => void navigate({ to: "/" }),
                })
              }
            />
          )}
        </div>
      </div>

      <div className="space-y-2">
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
      </div>

      <TagEditor model={model} editMode={editMode} />
      <ProvenanceBlock model={model} />
      <StorageLocationBar model={model} />
    </div>
  );
}
