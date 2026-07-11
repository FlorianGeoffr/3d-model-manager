/**
 * Print queue page (Branch 4 Task 2): an ordered "models to print" worklist.
 * No drag-and-drop (no new dependency) -- reordering is up/down buttons that
 * PATCH the entry to `position ± 1`; the backend clamps and returns the
 * whole reordered list, which `useQueue()` picks up via its own
 * invalidation. Table/empty-state conventions mirror `JobsPage.tsx`.
 */
import { Link } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";

import { ApiError } from "@/api/client";
import { useMoveQueueEntry, useQueue, useRemoveQueueEntry } from "@/api/queue";
import type { QueueEntry } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { FORMAT_LABELS } from "@/lib/formatMeta";

export function QueuePage() {
  const queueQuery = useQueue();
  const entries = queueQuery.data ?? [];

  return (
    <PageContainer width="default">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Print queue</h1>
        <p className="text-sm text-muted-foreground">Models lined up to print, in order.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Queue</CardTitle>
          <CardDescription>Reorder with the up/down buttons, or remove an entry entirely.</CardDescription>
        </CardHeader>
        <CardContent>
          {queueQuery.isLoading ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : queueQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {queueQuery.error instanceof ApiError ? queueQuery.error.detail : "Couldn't load the queue."}
            </p>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p>Your print queue is empty. Add models from their detail page.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((entry) => (
                <QueueRow key={entry.id} entry={entry} count={entries.length} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

function QueueRow({ entry, count }: { entry: QueueEntry; count: number }) {
  const moveEntry = useMoveQueueEntry();
  const removeEntry = useRemoveQueueEntry();
  const model = entry.model;

  const isFirst = entry.position <= 1;
  const isLast = entry.position >= count;

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="w-6 shrink-0 text-center font-mono text-sm text-muted-foreground">{entry.position}</span>

      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {model.cover ? (
          <img src={model.cover} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-[10px] font-semibold text-muted-foreground">
            {model.formats[0] ? FORMAT_LABELS[model.formats[0]] : "—"}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <Link to="/models/$slug" params={{ slug: model.slug }} className="truncate text-sm font-medium hover:underline">
          {model.name}
        </Link>
        <p className="text-xs text-muted-foreground">Added {formatDate(entry.added_at)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${model.name} up`}
          disabled={isFirst || moveEntry.isPending}
          onClick={() => moveEntry.mutate({ entryId: entry.id, position: entry.position - 1 })}
        >
          <ArrowUpIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Move ${model.name} down`}
          disabled={isLast || moveEntry.isPending}
          onClick={() => moveEntry.mutate({ entryId: entry.id, position: entry.position + 1 })}
        >
          <ArrowDownIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${model.name} from queue`}
          disabled={removeEntry.isPending}
          onClick={() => removeEntry.mutate(entry.id)}
        >
          <Trash2Icon className="size-4" />
          Remove
        </Button>
      </div>
    </li>
  );
}
