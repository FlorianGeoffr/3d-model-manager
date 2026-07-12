/**
 * Duplicate-files report (Branch 4 Task 2): files sharing a blob hash across
 * more than one model -- reclaimable storage from the same content having
 * been imported/uploaded more than once. Each row offers a confirm-gated
 * delete that reuses the model Files tab's own `DELETE /files/{id}`
 * mutation (`useDeleteFile`), then invalidates both this report and the
 * affected model's detail/files query.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";

import { ApiError } from "@/api/client";
import { useDeleteFile } from "@/api/library";
import { duplicatesReportQueryOptions, useDuplicatesReport } from "@/api/reports";
import type { DuplicateFile, DuplicateGroup } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { humanizeBytes } from "@/lib/format";

export function DuplicatesPage() {
  const reportQuery = useDuplicatesReport();
  const groups = reportQuery.data?.groups ?? [];

  return (
    <PageContainer width="default">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Duplicate files</h1>
        <p className="text-sm text-muted-foreground">
          {reportQuery.data
            ? `Reclaimable: ${humanizeBytes(reportQuery.data.total_wasted_bytes)}`
            : "Files with identical content stored more than once."}
        </p>
      </div>

      {reportQuery.isLoading ? (
        <Skeleton className="h-32 w-full rounded-lg" />
      ) : reportQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {reportQuery.error instanceof ApiError ? reportQuery.error.detail : "Couldn't load the duplicates report."}
        </p>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No duplicate files found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <DuplicateGroupCard key={group.blob_hash} group={group} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}

function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-sm">{group.blob_hash.slice(0, 12)}</CardTitle>
        <CardDescription>
          {humanizeBytes(group.size)} each · {humanizeBytes(group.wasted_bytes)} wasted across{" "}
          {group.files.length} files
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5">
          {group.files.map((file) => (
            <DuplicateFileRow key={file.file_id} file={file} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function DuplicateFileRow({ file }: { file: DuplicateFile }) {
  const queryClient = useQueryClient();
  // Same mutation the model's Files tab uses (`useDeleteFile`, keyed to
  // THIS file's own model -- duplicates by definition span different
  // models, so each row needs its own hook instance/slug).
  const deleteFile = useDeleteFile(file.model_slug);

  function handleConfirm() {
    deleteFile.mutate(file.file_id, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: duplicatesReportQueryOptions.queryKey }),
    });
  }

  return (
    <li className="flex items-center justify-between gap-2 text-sm">
      <div className="min-w-0">
        <Link to="/models/$slug" params={{ slug: file.model_slug }} className="hover:underline">
          {file.model_name} — {file.file_name}
        </Link>
        {file.model_archived && <span className="text-muted-foreground"> (archived)</span>}
        {deleteFile.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {deleteFile.error instanceof ApiError ? deleteFile.error.detail : "Could not delete the file"}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="destructive"
            size="icon-sm"
            aria-label={`Delete ${file.file_name}`}
            disabled={deleteFile.isPending}
          >
            <Trash2Icon />
          </Button>
        }
        title="Delete this copy?"
        description={`Removes "${file.file_name}" from ${file.model_name} and its stored bytes. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleConfirm}
      />
    </li>
  );
}
