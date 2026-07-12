import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  DownloadIcon,
  EllipsisIcon,
  FileStackIcon,
  FolderInputIcon,
  ListPlusIcon,
  PencilIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { useArchiveModel, useDeleteModel, usePatchModel, useRedownloadModel } from "@/api/library";
import { useEnqueueModel } from "@/api/queue";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InlineEdit } from "@/components/InlineEdit";
import { modelFilaments, revisionFormats } from "@/components/model-detail/modelSpec";
import { ProvenanceBlock } from "@/components/model-detail/ProvenanceBlock";
import { StorageLocationBar } from "@/components/model-detail/StorageLocationBar";
import { TagEditor } from "@/components/model-detail/TagEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilamentChip } from "@/components/ui/filament-chip";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SpecRow, type SpecItem } from "@/components/ui/spec-row";
import { formatDate, formatDateTime } from "@/lib/format";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import type { ModelDetail } from "@/api/types";

type RedownloadMode = "revision" | "replace";

/** "Re-download from source" (feat/import-fidelity T3, `POST
 * /models/{slug}/redownload`) -- an additive action, NOT gated behind edit
 * mode (same posture as "Add to queue"), reached via the header's "More
 * actions" overflow menu. Its menu item is disabled for a model with no
 * resolvable import source (`check_redownload_source` on the backend 409s
 * for the same reason) rather than opening a dialog that would just fail. */
function RedownloadDialog({
  model,
  open,
  onOpenChange,
}: {
  model: ModelDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<RedownloadMode>("revision");
  const redownload = useRedownloadModel(model.slug);

  function handleStart() {
    redownload.mutate(
      { mode },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success("Re-download started");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setMode("revision");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-download from source</DialogTitle>
          <DialogDescription>
            Re-fetches this model&apos;s files fresh from where it was imported.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={mode}
          onValueChange={(next) => setMode(next as RedownloadMode)}
          className="py-2"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="revision" id="redownload-mode-revision" />
            <Label htmlFor="redownload-mode-revision" className="font-normal">
              New revision (keeps current files as history)
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="replace" id="redownload-mode-replace" />
            <Label htmlFor="redownload-mode-replace" className="font-normal">
              Replace current files
            </Label>
          </div>
        </RadioGroup>
        <DialogFooter>
          <Button type="button" disabled={redownload.isPending} onClick={handleStart}>
            {redownload.isPending ? "Starting..." : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  const deleteModel = useDeleteModel(model.slug);
  const enqueueModel = useEnqueueModel();

  const [redownloadOpen, setRedownloadOpen] = useState(false);
  const [relocateOpen, setRelocateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canRedownload = Boolean(model.source_site && model.source_url);

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
              {/* Keep the page's h1 in the heading outline even while the
                  name is editable -- InlineEdit renders spans, so nesting
                  it here is valid and screen readers still see a level-1
                  heading in both modes. */}
              <h1 className="text-2xl font-semibold">
                <InlineEdit
                  value={model.name}
                  aria-label="name"
                  onSave={(name) => {
                    if (name) patchModel.mutate({ name });
                  }}
                  className="text-2xl font-semibold"
                />
              </h1>
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
          {/* A star is a deliberate, always-live action -- not part of the
              edit gate the way name/description/tags/archive are. */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={model.favorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={model.favorite}
            onClick={() => patchModel.mutate({ favorite: !model.favorite })}
          >
            <StarIcon className={model.favorite ? "fill-amber-400 text-amber-500" : ""} />
          </Button>
          {/* Queueing a model to print is a normal action too, not an edit. */}
          <Button
            type="button"
            variant="outline"
            disabled={enqueueModel.isPending}
            onClick={() =>
              enqueueModel.mutate(model.id, {
                onSuccess: () => toast.success("Added to queue"),
              })
            }
          >
            <ListPlusIcon />
            Add to queue
          </Button>
          <Button type="button" variant="outline" onClick={onToggleEditMode}>
            <PencilIcon />
            {editMode ? "Done" : "Edit"}
          </Button>
          {/* Lifecycle actions (re-download, relocate, archive, delete) live
              behind this overflow menu regardless of edit mode -- edit mode
              only gates metadata (name/description/tags). Each item opens
              its existing dialog via controlled `open` state rather than a
              nested `DialogTrigger`, so the dialog survives the menu
              unmounting when it closes (standard Radix menu+dialog
              composition). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="icon" aria-label="More actions">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!canRedownload} onSelect={() => setRedownloadOpen(true)}>
                <DownloadIcon />
                Re-download…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRelocateOpen(true)}>
                <FolderInputIcon />
                Move / copy…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                <ArchiveIcon />
                Archive…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2Icon />
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <RedownloadDialog model={model} open={redownloadOpen} onOpenChange={setRedownloadOpen} />
          <ConfirmDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            title={`Archive "${model.name}"?`}
            description="Archived models are hidden from the library by default. This does not delete files."
            confirmLabel="Archive"
            destructive
            onConfirm={() => archiveModel.mutate(true)}
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Delete this model?"
            description="Permanently deletes the model and every file from storage. This cannot be undone."
            confirmLabel="Delete"
            destructive
            onConfirm={() =>
              deleteModel.mutate(undefined, {
                onSuccess: () => void navigate({ to: "/" }),
              })
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SpecRow items={specItems} />
          {/* Not edit-gated -- a print history fact, not editable metadata,
              same treatment as the favorite star. */}
          {model.print_count > 0 ? (
            <Badge variant="secondary" title={`Last printed ${formatDateTime(model.last_printed_at)}`}>
              Printed {model.print_count}×
            </Badge>
          ) : null}
        </div>
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
      <StorageLocationBar model={model} open={relocateOpen} onOpenChange={setRelocateOpen} />
    </div>
  );
}
