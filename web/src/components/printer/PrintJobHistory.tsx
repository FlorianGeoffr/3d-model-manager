/**
 * Print-job history table (M4 Task 8): lists `GET /print-jobs` (most-recent-
 * first, per the backend's `PrintJob.id.desc()` ordering -- no client-side
 * re-sort needed), polling while any listed job is still active
 * (`usePrintJobs`'s `refetchInterval`).
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  CameraIcon,
  ClockIcon,
  ExternalLinkIcon,
  EyeIcon,
  LayersIcon,
} from "lucide-react";

import { usePrintJobs } from "@/api/printers";
import type { PrintJobOut, PrintJobState } from "@/api/types";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, humanizeDuration } from "@/lib/format";

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

function JobThumbnail({
  job,
  onOpenModal,
}: {
  job: PrintJobOut;
  onOpenModal: () => void;
}) {
  const [thumbError, setThumbError] = useState(false);
  const [snapError, setSnapError] = useState(false);

  // If there is a finish photo snapshot available and not errored, show it with a camera badge
  if (job.snapshot_url && !snapError) {
    return (
      <div
        className="group relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border bg-muted transition-transform hover:scale-105"
        onClick={onOpenModal}
        title="View print finish photo"
      >
        <img
          src={job.snapshot_url}
          alt={job.subtask_name ?? "Print result"}
          className="size-full object-cover"
          onError={() => setSnapError(true)}
          loading="lazy"
        />
        <span className="absolute bottom-0.5 right-0.5 flex size-4 items-center justify-center rounded bg-black/70 text-[9px] text-white">
          <CameraIcon className="size-2.5" />
        </span>
      </div>
    );
  }

  // Sliced / 3D model thumbnail preview
  if (job.thumbnail_url && !thumbError) {
    return (
      <div
        className="group relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border bg-muted transition-transform hover:scale-105"
        onClick={onOpenModal}
        title="View 3D preview"
      >
        <img
          src={job.thumbnail_url}
          alt={job.subtask_name ?? "Model preview"}
          className="size-full object-cover"
          onError={() => setThumbError(true)}
          loading="lazy"
        />
        <span className="absolute bottom-0.5 right-0.5 flex size-4 items-center justify-center rounded bg-black/70 text-[9px] font-bold text-white">
          3D
        </span>
      </div>
    );
  }

  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
      <BoxIcon className="size-6 opacity-60" />
    </div>
  );
}

function PrintJobRow({
  job,
  onOpenModal,
}: {
  job: PrintJobOut;
  onOpenModal: () => void;
}) {
  const durationText = job.duration_s
    ? humanizeDuration(job.duration_s)
    : job.print_time_s
      ? `est. ${humanizeDuration(job.print_time_s)}`
      : null;

  return (
    <TableRow className="transition-colors hover:bg-muted/40">
      <TableCell className="w-14 p-2.5">
        <JobThumbnail job={job} onOpenModal={onOpenModal} />
      </TableCell>
      <TableCell className="max-w-64">
        {job.model_slug ? (
          <Link
            to="/models/$slug"
            params={{ slug: job.model_slug }}
            className="block truncate font-medium text-foreground hover:underline"
            title={job.model_name ?? job.model_slug}
          >
            {job.model_name ?? job.model_slug}
          </Link>
        ) : (
          <div className="truncate font-medium text-foreground" title={job.subtask_name ?? `Job #${job.id}`}>
            {job.subtask_name ?? `Job #${job.id}`}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {job.file_rel_path ? (
            <span className="truncate font-mono" title={job.file_rel_path}>
              {job.file_rel_path}
            </span>
          ) : job.file_id ? (
            <span className="truncate font-mono">File #{job.file_id}</span>
          ) : job.model_slug ? (
            <span className="truncate font-mono" title={job.subtask_name ?? undefined}>
              {job.subtask_name ?? "—"}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/80">External print</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <Badge variant={STATE_VARIANT[job.state]} className="capitalize">
              {job.state}
            </Badge>
            {job.state === "printing" && job.progress_pct != null && (
              <span className="text-xs font-semibold text-primary">
                {Math.round(job.progress_pct)}%
              </span>
            )}
          </div>
          {job.state === "printing" && job.progress_pct != null && (
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.max(0, Math.min(100, job.progress_pct))}%` }}
              />
            </div>
          )}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-foreground">
        {durationText ? (
          <div className="flex items-center gap-1.5" title="Print duration">
            <ClockIcon className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{durationText}</span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {job.filament_g != null || (job.filament_types && job.filament_types.length > 0) ? (
          <div className="flex flex-col gap-1">
            {job.filament_types && job.filament_types.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {job.filament_types.map((type, i) => (
                  <Badge key={i} variant="outline" className="px-1.5 py-0 text-[10px]">
                    {type}
                  </Badge>
                ))}
              </div>
            )}
            {job.filament_g != null && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <LayersIcon className="size-3" />
                <span>
                  {Math.round(job.filament_g)} g
                  {job.filament_m != null ? ` (${job.filament_m.toFixed(1)} m)` : ""}
                </span>
              </div>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(job.started_at ?? job.created_at)}
      </TableCell>
      <TableCell className="max-w-40 truncate text-xs text-destructive" title={job.printer_error ?? undefined}>
        {job.printer_error ?? ""}
      </TableCell>
    </TableRow>
  );
}

export function PrintJobHistory() {
  const printJobs = usePrintJobs();
  const [selectedJob, setSelectedJob] = useState<PrintJobOut | null>(null);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <div>
            <CardTitle>Print job history</CardTitle>
            <CardDescription>
              Every print sent from this app, with print time, material used, and photos.
            </CardDescription>
          </div>
          {printJobs.data && printJobs.data.length > 0 && (
            <Badge variant="secondary">{printJobs.data.length} jobs</Badge>
          )}
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">Preview</TableHead>
                    <TableHead>File / Model</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Print Time</TableHead>
                    <TableHead>Material</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {printJobs.data.map((job) => (
                    <PrintJobRow key={job.id} job={job} onOpenModal={() => setSelectedJob(job)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal dialog for photo snapshot or 3D preview */}
      {selectedJob && (
        <Dialog open={!!selectedJob} onOpenChange={(open) => !open && setSelectedJob(null)}>
          <DialogContent className="max-w-2xl overflow-hidden p-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {selectedJob.snapshot_url ? (
                  <>
                    <CameraIcon className="size-5 text-primary" />
                    <span>Finished Print Photo</span>
                  </>
                ) : (
                  <>
                    <BoxIcon className="size-5 text-primary" />
                    <span>Print Job Preview</span>
                  </>
                )}
              </DialogTitle>
              <DialogDescription>
                {selectedJob.model_name ?? selectedJob.subtask_name ?? `Job #${selectedJob.id}`}
              </DialogDescription>
            </DialogHeader>

            {/* Media preview */}
            <div className="relative flex max-h-[60vh] items-center justify-center overflow-hidden rounded-xl border border-border bg-black/5 dark:bg-black/50 p-2">
              <img
                src={selectedJob.snapshot_url ?? selectedJob.thumbnail_url ?? ""}
                alt={selectedJob.subtask_name ?? "Print preview"}
                className="max-h-[55vh] max-w-full rounded-lg object-contain shadow-sm"
              />
            </div>

            {/* Print metadata statistics grid */}
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border/60 bg-muted/30 p-3.5 text-xs sm:grid-cols-4">
              <div>
                <span className="text-muted-foreground">State</span>
                <div className="mt-0.5 font-medium capitalize">{selectedJob.state}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Print Duration</span>
                <div className="mt-0.5 font-medium">
                  {selectedJob.duration_s
                    ? humanizeDuration(selectedJob.duration_s)
                    : selectedJob.print_time_s
                      ? `~${humanizeDuration(selectedJob.print_time_s)}`
                      : "—"}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Filament Used</span>
                <div className="mt-0.5 font-medium">
                  {selectedJob.filament_g != null ? `${Math.round(selectedJob.filament_g)} g` : "—"}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Material</span>
                <div className="mt-0.5 font-medium">
                  {selectedJob.filament_types?.join(", ") || "—"}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground">
                Started {formatDateTime(selectedJob.started_at ?? selectedJob.created_at)}
              </span>
              {selectedJob.model_slug && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/models/$slug" params={{ slug: selectedJob.model_slug }}>
                    <EyeIcon className="mr-1.5 size-3.5" />
                    Open in 3D Studio
                    <ExternalLinkIcon className="ml-1 size-3" />
                  </Link>
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
