import { useState } from "react";

import { useCreateRevision, useRevisionDiff, useRevisions } from "@/api/library";
import { ApiError } from "@/api/client";
import { DiffView } from "@/components/model-detail/DiffView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import type { ModelDetail, RevisionSummary } from "@/api/types";

function RevisionSelect({
  revisions,
  value,
  onChange,
  label,
}: {
  revisions: RevisionSummary[];
  value: number | undefined;
  onChange: (id: number) => void;
  label: string;
}) {
  return (
    <Select value={value ? String(value) : undefined} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {revisions.map((revision) => (
          <SelectItem key={revision.id} value={String(revision.id)}>
            #{revision.number} {revision.name ?? ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewRevisionDialog({ model }: { model: ModelDetail }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const createRevision = useCreateRevision(model.slug, model.id);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createRevision.mutate(
      { name: name || undefined, note: note || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          setName("");
          setNote("");
        },
      },
    );
  }

  const errorMessage =
    createRevision.error instanceof ApiError
      ? createRevision.error.detail
      : createRevision.error
        ? "Could not create revision"
        : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          New revision
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New revision</DialogTitle>
            <DialogDescription>
              Snapshots every file on the current revision, then applies future changes on top.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="revision-name">Name</Label>
              <Input id="revision-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="revision-note">Note</Label>
              <Textarea id="revision-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
            </div>
            {errorMessage ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={createRevision.isPending}>
              {createRevision.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RevisionsTab({ model }: { model: ModelDetail }) {
  const revisionsQuery = useRevisions(model.id);
  const revisions = revisionsQuery.data ?? [];
  const [diffA, setDiffA] = useState<number>();
  const [diffB, setDiffB] = useState<number>();
  const diffQuery = useRevisionDiff(diffA, diffB);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">History</h3>
        <NewRevisionDialog model={model} />
      </div>

      <ol className="space-y-4 border-l border-border pl-4">
        {revisions.map((revision) => (
          <li key={revision.id} className="relative">
            <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full bg-primary" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">#{revision.number}</span>
              {revision.name ? <span className="text-sm">{revision.name}</span> : null}
              {model.current_revision?.id === revision.id ? <Badge>Current</Badge> : null}
            </div>
            {revision.note ? <p className="text-sm text-muted-foreground">{revision.note}</p> : null}
            <p className="text-xs text-muted-foreground">
              {formatDateTime(revision.created_at)} · {revision.file_count} files
            </p>
          </li>
        ))}
      </ol>

      {revisions.length >= 2 && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <h4 className="text-sm font-semibold">Compare revisions</h4>
          <div className="flex items-center gap-2">
            <RevisionSelect revisions={revisions} value={diffA} onChange={setDiffA} label="From" />
            <span className="text-muted-foreground">→</span>
            <RevisionSelect revisions={revisions} value={diffB} onChange={setDiffB} label="To" />
          </div>
          {diffQuery.data ? <DiffView diff={diffQuery.data} /> : null}
        </div>
      )}
    </div>
  );
}
