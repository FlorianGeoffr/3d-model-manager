/**
 * Print-job history table (M4 Task 8): lists `GET /print-jobs` (most-recent-
 * first, per the backend's `PrintJob.id.desc()` ordering -- no client-side
 * re-sort needed), polling while any listed job is still active
 * (`usePrintJobs`'s `refetchInterval`).
 */
import { usePrintJobs } from "@/api/printers";
import type { PrintJobOut, PrintJobState } from "@/api/types";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

const STATE_VARIANT: Record<PrintJobState, "default" | "secondary" | "outline" | "destructive"> = {
  queued: "outline",
  uploading: "secondary",
  starting: "secondary",
  printing: "default",
  paused: "secondary",
  finished: "default",
  failed: "destructive",
  canceled: "outline",
};

function PrintJobRow({ job }: { job: PrintJobOut }) {
  return (
    <TableRow>
      <TableCell className="max-w-64 truncate text-sm" title={job.subtask_name ?? undefined}>
        {job.subtask_name ?? `File #${job.file_id}`}
      </TableCell>
      <TableCell>
        <Badge variant={STATE_VARIANT[job.state]}>{job.state}</Badge>
      </TableCell>
      <TableCell>{job.progress_pct != null ? `${Math.round(job.progress_pct)}%` : "--"}</TableCell>
      <TableCell>{formatDateTime(job.created_at)}</TableCell>
      <TableCell className="max-w-48 truncate text-destructive" title={job.printer_error ?? undefined}>
        {job.printer_error ?? ""}
      </TableCell>
    </TableRow>
  );
}

export function PrintJobHistory() {
  const printJobs = usePrintJobs();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Print job history</CardTitle>
        <CardDescription>Every print sent from this app, most recent first.</CardDescription>
      </CardHeader>
      <CardContent>
        {printJobs.isLoading ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : printJobs.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {printJobs.error instanceof ApiError ? printJobs.error.detail : "Couldn't load print jobs."}
          </p>
        ) : !printJobs.data || printJobs.data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No print jobs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {printJobs.data.map((job) => (
                <PrintJobRow key={job.id} job={job} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
