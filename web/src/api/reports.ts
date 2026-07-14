/**
 * Duplicate-files report (backend/app/schemas/reports.py, Branch 4 Task 1):
 * files sharing a blob hash across more than one model -- reclaimable
 * storage from the same content having been imported/uploaded more than once.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { DuplicatesReport, DuplicatesResolveOut, KeepChoice } from "@/api/types";

// Exported as `queryOptions` (not just a bare hook) so `DuplicatesPage`'s
// per-row delete can invalidate this query by key after a successful
// `DELETE /files/{id}` -- same `queryOptions` pattern as `tagsQueryOptions`
// in `api/library.ts`.
export const duplicatesReportQueryOptions = queryOptions({
  queryKey: ["reports", "duplicates"] as const,
  queryFn: () => api.get<DuplicatesReport>("/reports/duplicates"),
});

export function useDuplicatesReport() {
  return useQuery(duplicatesReportQueryOptions);
}

// `POST /reports/duplicates/resolve` (Round 11 T4): resolve one or more
// duplicate groups down to their chosen keeper, deleting every other copy.
// Invalidates both this report AND `["models"]` -- the deletions change
// affected models' detail/file lists, same posture as `useBulkDeleteModels`
// in `api/library.ts`.
export function useResolveDuplicates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keep: KeepChoice[]) => api.post<DuplicatesResolveOut>("/reports/duplicates/resolve", { keep }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: duplicatesReportQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}
