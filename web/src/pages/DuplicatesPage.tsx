/**
 * Duplicate-files report (Branch 4 Task 2): files sharing a blob hash across
 * more than one model -- reclaimable storage from the same content having
 * been imported/uploaded more than once. Read-only (no delete-from-here
 * action -- files are removed from the model's Files tab, same as any other
 * file).
 */
import { Link } from "@tanstack/react-router";

import { ApiError } from "@/api/client";
import { useDuplicatesReport } from "@/api/reports";
import type { DuplicateGroup } from "@/api/types";
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
            <li key={file.file_id} className="text-sm">
              <Link to="/models/$slug" params={{ slug: file.model_slug }} className="hover:underline">
                {file.model_name} — {file.file_name}
              </Link>
              {file.model_archived && <span className="text-muted-foreground"> (archived)</span>}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
