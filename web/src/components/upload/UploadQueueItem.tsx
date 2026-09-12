import { XIcon } from "lucide-react";

import type { ExistingUploadModel } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { humanizeBytes } from "@/lib/format";

export type QueueStatus = "pending" | "uploading" | "processing" | "stored" | "failed" | "duplicate";

export interface QueueItem {
  id: string;
  file: File;
  relPath: string;
  size: number;
  progress: number;
  status: QueueStatus;
  error?: string;
  jobId?: string;
  /** Set when `status === "duplicate"` (R11-C item 18): the library model
   * that already has this content, plus a suggested rename. */
  duplicate?: { existing: ExistingUploadModel; suggestedName: string };
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  pending: "Pending",
  uploading: "Uploading",
  processing: "Processing",
  stored: "Stored",
  failed: "Failed",
  duplicate: "Duplicate",
};

const STATUS_VARIANT: Record<QueueStatus, "outline" | "secondary" | "destructive"> = {
  pending: "outline",
  uploading: "outline",
  processing: "secondary",
  stored: "secondary",
  failed: "destructive",
  duplicate: "destructive",
};

interface UploadQueueItemProps {
  item: QueueItem;
  onRelPathChange: (relPath: string) => void;
  onRemove: () => void;
  /** Retries this item's upload with `allow_duplicate=true` (R11-C item 18). */
  onUploadAnyway?: () => void;
}

/** One row in the upload queue: editable rel_path, progress bar, status chip.
 * A "duplicate" item additionally shows an inline card pointing at the
 * existing model, with "Open existing"/"Upload anyway" actions. */
export function UploadQueueItem({ item, onRelPathChange, onRemove, onUploadAnyway }: UploadQueueItemProps) {
  const editable = item.status === "pending";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Input
            value={item.relPath}
            onChange={(event) => onRelPathChange(event.target.value)}
            disabled={!editable}
            className="font-mono text-xs"
            aria-label={`Path for ${item.file.name}`}
          />
          <div className="flex items-center gap-2">
            <Progress value={item.progress} className="h-1.5 flex-1" aria-label={`Progress for ${item.file.name}`} />
            <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">{humanizeBytes(item.size)}</span>
          </div>
          {item.error ? <p className="text-xs text-destructive">{item.error}</p> : null}
        </div>
        <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
        {editable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${item.file.name}`}
            onClick={onRemove}
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {item.status === "duplicate" && item.duplicate && (
        <Card className="py-3">
          <CardContent className="flex flex-wrap items-center gap-2 px-3 text-sm">
            <span>
              Already in your library:{" "}
              <a href={item.duplicate.existing.url} className="font-medium underline">
                {item.duplicate.existing.name}
              </a>
            </span>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" size="sm" asChild>
                <a href={item.duplicate.existing.url}>Open existing</a>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={onUploadAnyway}>
                Upload anyway
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
