/**
 * Query/mutation hooks for the gallery-import domain (M5 Task 6): kick off
 * an import from a URL, poll it until terminal, and read/set the
 * Thingiverse app token. Mirrors `settings.ts`'s `queryOptions`/mutation
 * shape and `jobs.ts`'s refetchInterval-stops-on-terminal-state idiom.
 * `useImportSearch` (Workstream B task B3) backs the Search tab's
 * browse-then-import flow against `GET /imports/search`.
 */
import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  ImportCreate,
  ImportOut,
  ImportSite,
  ImportTokensIn,
  ImportTokensOut,
  SearchResponse,
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

/** Federated browse-then-import search (M8 E1's `GET /imports/search`): queries
 * the selected `sites` at once (repeat `?site=`), paginated via
 * `useInfiniteQuery` — `getNextPageParam` advances while ANY site still reports
 * `has_more`. Enabled once `q` is non-empty and at least one site is selected
 * (an empty site list would otherwise read to the backend as "all sites"). The
 * caller passes an already-debounced `q`. */
export function useImportSearch(sites: ImportSite[], q: string) {
  const query = q.trim();
  const selected = [...sites].sort();
  const siteParams = selected.map((s) => `&site=${encodeURIComponent(s)}`).join("");
  return useInfiniteQuery({
    queryKey: ["imports", "search", selected, query] as const,
    queryFn: ({ pageParam }) =>
      api.get<SearchResponse>(
        `/imports/search?q=${encodeURIComponent(query)}&page=${pageParam}${siteParams}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.per_site.some((s) => s.has_more) ? allPages.length + 1 : undefined,
    enabled: query.length > 0 && selected.length > 0,
  });
}
