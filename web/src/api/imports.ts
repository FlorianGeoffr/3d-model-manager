/**
 * Query/mutation hooks for the gallery-import domain (M5 Task 6): kick off
 * an import from a URL, poll it until terminal, and read/set the
 * Thingiverse app token. Mirrors `settings.ts`'s `queryOptions`/mutation
 * shape and `jobs.ts`'s refetchInterval-stops-on-terminal-state idiom.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { ImportCreate, ImportOut, ImportTokensIn, ImportTokensOut } from "@/api/types";

const ACTIVE: ReadonlyArray<ImportOut["state"]> = ["pending", "fetching", "downloading"];

export function useCreateImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportCreate) => api.post<ImportOut>("/imports", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["imports"] }),
  });
}

/** Polls a single import until it reaches a terminal state, then stops. */
export function useImport(id: number | undefined) {
  return useQuery({
    queryKey: ["imports", id] as const,
    queryFn: () => api.get<ImportOut>(`/imports/${id}`),
    enabled: id !== undefined,
    refetchInterval: (q) => (ACTIVE.includes(q.state.data?.state ?? "done") ? 1500 : false),
  });
}

export const importTokensQueryOptions = queryOptions({
  queryKey: ["settings", "import-tokens"] as const,
  queryFn: () => api.get<ImportTokensOut>("/settings/import-tokens"),
});
export function useImportTokens() {
  return useQuery(importTokensQueryOptions);
}
export function useUpdateImportTokens() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportTokensIn) => api.put<ImportTokensOut>("/settings/import-tokens", body),
    onSuccess: (data) => qc.setQueryData(importTokensQueryOptions.queryKey, data),
  });
}
