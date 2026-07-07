import { useNavigate } from "@tanstack/react-router";

import { useArchiveModel, usePatchModel } from "@/api/library";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineEdit } from "@/components/InlineEdit";
import { ProvenanceBlock } from "@/components/model-detail/ProvenanceBlock";
import { TagEditor } from "@/components/model-detail/TagEditor";
import { Button } from "@/components/ui/button";
import type { ModelDetail } from "@/api/types";

export function ModelHeader({ model }: { model: ModelDetail }) {
  const navigate = useNavigate();
  const patchModel = usePatchModel(model.slug);
  const archiveModel = useArchiveModel(model.slug);

  return (
    <div className="space-y-3 border-b border-border pb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <InlineEdit
            value={model.name}
            aria-label="Model name"
            onSave={(name) => {
              if (name) patchModel.mutate({ name });
            }}
            displayClassName="text-2xl font-semibold"
            className="text-2xl font-semibold"
          />
          <InlineEdit
            value={model.description ?? ""}
            placeholder="Add a description…"
            aria-label="Model description"
            multiline
            onSave={(description) => patchModel.mutate({ description: description || null })}
            displayClassName="block text-sm text-muted-foreground"
          />
        </div>
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
      </div>
      <TagEditor model={model} />
      <ProvenanceBlock model={model} />
    </div>
  );
}
