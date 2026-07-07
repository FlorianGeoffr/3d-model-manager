/**
 * Query/mutation hooks for the scan domain (Task 8): trigger a library scan
 * and read back its latest report. Mirrors `settings.ts`'s shape (Task 7).
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { ScanRunOut } from "@/api/types";

// The Scan section only ever surfaces the latest run (Task 8 brief), so a
// history of one is all this needs to fetch.
export const scanRunsQueryOptions = queryOptions({
  queryKey: ["scan", "runs"] as const,
  queryFn: () => api.get<ScanRunOut[]>("/scan-runs?limit=1"),
});

export function useScanRuns() {
  return useQuery(scanRunsQueryOptions);
}

/** `POST /api/scan` -- 409s if a scan is already running (surfaced via the
 * mutation's `error`, same as every other `ApiError` in the app). */
export function useTriggerScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ScanRunOut>("/scan"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["scan"] }),
  });
}
