/**
 * Print history (backend/app/schemas/prints.py, Branch 5 Task 1): a
 * user-entered log of print attempts, distinct from the print queue's
 * "models to print" worklist (`queue.ts`) and print-jobs' live
 * send-to-printer telemetry (`printers.ts`, M4). Mirrors `queue.ts`'s hook
 * conventions -- `useQuery`/`useMutation` + `queryClient.invalidateQueries`.
 *
 * Every mutation also invalidates the model-detail query (`modelQueryOptions`
 * from `library.ts`) since `ModelDetail.print_count`/`last_printed_at` are
 * server-computed aggregates over these rows -- a bare `["prints", modelId]`
 * invalidation wouldn't refresh the header chip that reads them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import { modelQueryOptions } from "@/api/library";
import type { PrintCreateIn, PrintEntry, PrintPatchIn } from "@/api/types";

function printsQueryKey(modelId: number) {
  return ["prints", modelId] as const;
}

/** A model's print log, reverse-chronological (server order). */
export function usePrints(modelId: number) {
  return useQuery({
    queryKey: printsQueryKey(modelId),
    queryFn: () => api.get<PrintEntry[]>(`/models/${modelId}/prints`),
  });
}

export function useLogPrint(modelId: number, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PrintCreateIn) => api.post<PrintEntry>(`/models/${modelId}/prints`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: printsQueryKey(modelId) });
      void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey });
    },
  });
}

export function usePatchPrint(modelId: number, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: PrintPatchIn }) =>
      api.patch<PrintEntry>(`/prints/${id}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: printsQueryKey(modelId) });
      void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey });
    },
  });
}

export function useDeletePrint(modelId: number, slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/prints/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: printsQueryKey(modelId) });
      void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey });
    },
  });
}
