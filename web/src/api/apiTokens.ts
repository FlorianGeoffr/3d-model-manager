/**
 * Query/mutation hooks for the browser-extension API tokens (M10 Workstream
 * C task C): mint a token (the plaintext is only ever present in the mint
 * response), list existing tokens (never the plaintext or its hash), and
 * revoke one by id. Mirrors `printables.ts`'s `queryOptions`/mutation shape.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { ApiTokenCreateIn, ApiTokenMintOut, ApiTokenOut } from "@/api/types";

export const apiTokensQueryOptions = queryOptions({
  queryKey: ["settings", "api-tokens"] as const,
  queryFn: () => api.get<ApiTokenOut[]>("/settings/api-tokens"),
});

export function useApiTokens() {
  return useQuery(apiTokensQueryOptions);
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiTokenCreateIn) => api.post<ApiTokenMintOut>("/settings/api-tokens", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: apiTokensQueryOptions.queryKey }),
  });
}

export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>("/settings/api-tokens/" + id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: apiTokensQueryOptions.queryKey }),
  });
}
