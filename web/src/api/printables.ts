/**
 * Query/mutation hooks for the Printables account connect flow (Workstream A
 * task A1): read connection status, connect (paste a refresh token, which
 * the backend validates and rotates), and disconnect. Mirrors `bambu.ts`'s
 * `queryOptions`/mutation shape. Connecting an account is what will make the
 * Saved tab's Printables collections/likes sync possible (task A4) -- see
 * `app/services/printables_auth.py`.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { PrintablesConnectIn, PrintablesStatusOut } from "@/api/types";

export const printablesStatusQueryOptions = queryOptions({
  queryKey: ["settings", "printables"] as const,
  queryFn: () => api.get<PrintablesStatusOut>("/settings/printables"),
});

export function usePrintablesStatus() {
  return useQuery(printablesStatusQueryOptions);
}

export function usePrintablesConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PrintablesConnectIn) =>
      api.post<PrintablesStatusOut>("/settings/printables/connect", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: printablesStatusQueryOptions.queryKey }),
  });
}

export function usePrintablesDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/settings/printables"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: printablesStatusQueryOptions.queryKey }),
  });
}
