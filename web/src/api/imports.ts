/**
 * Query/mutation hooks for the gallery-import domain (M5 Task 6): kick off
 * an import from a URL, poll it until terminal, and read/set the
 * Thingiverse app token. Mirrors `settings.ts`'s `queryOptions`/mutation
 * shape and `jobs.ts`'s refetchInterval-stops-on-terminal-state idiom.
 * `useImportSearch` (Workstream B task B3) backs the Search tab's
 * browse-then-import flow against `GET /imports/search`.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  ImportCreate,
  ImportOut,
  ImportSite,
  ImportTokensIn,
  ImportTokensOut,
  SearchResult,
} from "@/api/types";

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

/** Browse-then-import search (Workstream B task B1's `GET /imports/search`)
 * against a single site. Enabled only once `q` is non-empty -- the caller is
 * expected to pass an already-debounced `q` (mirrors `useModelSearchQuery`'s
 * `enabled` gate in `library.ts`). */
export function useImportSearch(site: ImportSite, q: string, page = 1) {
  const query = q.trim();
  return useQuery({
    queryKey: ["imports", "search", site, query, page] as const,
    queryFn: () =>
      api.get<SearchResult[]>(
        `/imports/search?site=${encodeURIComponent(site)}&q=${encodeURIComponent(query)}&page=${page}`,
      ),
    enabled: query.length > 0,
  });
}
