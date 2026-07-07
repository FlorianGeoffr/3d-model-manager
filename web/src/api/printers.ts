/**
 * Query/mutation hooks for the printers domain (M4 Task 8): printers CRUD,
 * the Developer-Mode test probe, the live status poll, print-job history,
 * and pause/resume/stop commands. Mirrors `settings.ts`'s shape; the status
 * and print-jobs polls stop once there's nothing active left to watch, same
 * principle as `jobs.ts`'s `useJob`.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  PrinterCreate,
  PrinterOut,
  PrinterStatusOut,
  PrinterUpdate,
  PrintJobOut,
  PrintRequest,
  ProbeOut,
} from "@/api/types";

// `gcode_state` values that mean "actively doing something" -- poll fast
// while any of these hold, back off to a slow heartbeat otherwise.
const ACTIVE_GCODE = ["RUNNING", "PREPARE", "PAUSE"];
// `PrintJobOut.state` values that haven't reached a terminal state yet.
const ACTIVE_JOB = ["queued", "uploading", "starting", "printing", "paused"];

export const printersQueryOptions = queryOptions({
  queryKey: ["printers"] as const,
  queryFn: () => api.get<PrinterOut[]>("/printers"),
});

export function usePrinters(options?: { enabled?: boolean }) {
  return useQuery({ ...printersQueryOptions, enabled: options?.enabled ?? true });
}

export function useCreatePrinter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PrinterCreate) => api.post<PrinterOut>("/printers", b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["printers"] }),
  });
}

export function useUpdatePrinter(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PrinterUpdate) => api.patch<PrinterOut>(`/printers/${id}`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["printers"] }),
  });
}

export function useDeletePrinter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/printers/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["printers"] }),
  });
}

export function useTestPrinter(id: number) {
  return useMutation({ mutationFn: () => api.post<ProbeOut>(`/printers/${id}/test`) });
}

/** Polls `GET /printers/{id}/status`, speeding up while the printer is
 * actively running/preparing/paused and backing off to a slow heartbeat
 * otherwise -- never stops entirely (unlike `useJob`/`usePrintJobs`) since
 * "last known status" is worth refreshing even while idle. */
export function usePrinterStatus(id: number) {
  return useQuery({
    queryKey: ["printers", id, "status"] as const,
    queryFn: () => api.get<PrinterStatusOut>(`/printers/${id}/status`),
    refetchInterval: (q) => (ACTIVE_GCODE.includes(q.state.data?.gcode_state ?? "") ? 2500 : 8000),
  });
}

export function usePrinterCommand(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: "pause" | "resume" | "stop") => api.post<void>(`/printers/${id}/${cmd}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["printers", id, "status"] }),
  });
}

/** Polls `GET /print-jobs`, stopping once every job in the current page has
 * reached a terminal state (mirrors `useJob`'s terminal-state stop). */
export function usePrintJobs(printerId?: number) {
  return useQuery({
    queryKey: ["print-jobs", printerId ?? null] as const,
    queryFn: () => api.get<PrintJobOut[]>(`/print-jobs${printerId ? `?printer_id=${printerId}` : ""}`),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ACTIVE_JOB.includes(j.state)) ? 3000 : false),
  });
}

export function useStartPrint(printerId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PrintRequest) => api.post<PrintJobOut>(`/printers/${printerId}/print`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["print-jobs"] }),
  });
}
