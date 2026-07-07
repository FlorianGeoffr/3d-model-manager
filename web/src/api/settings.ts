/**
 * Query/mutation hooks for the storage-settings domain (Task 7): read/set
 * the active storage backend config, probe a candidate config, and kick off
 * the copy+verify+cutover migration job. Mirrors `library.ts`'s shape.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { ConnectionTestOut, JobOut, StorageConfigIn, StorageConfigOut } from "@/api/types";

export const storageConfigQueryOptions = queryOptions({
  queryKey: ["settings", "storage"] as const,
  queryFn: () => api.get<StorageConfigOut>("/settings/storage"),
});

export function useStorageConfig() {
  return useQuery(storageConfigQueryOptions);
}

/** Direct set (`PUT`) -- for pointing at an already-populated or empty
 * backend with no copy needed. `useMigrateStorage` below is the safe
 * "copy the existing library across, verify, then cut over" path. */
export function useUpdateStorageConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: StorageConfigIn) => api.put<StorageConfigOut>("/settings/storage", payload),
    onSuccess: (data) => queryClient.setQueryData(storageConfigQueryOptions.queryKey, data),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (payload: StorageConfigIn) => api.post<ConnectionTestOut>("/settings/storage/test", payload),
  });
}

export function useMigrateStorage() {
  return useMutation({
    mutationFn: (payload: StorageConfigIn) => api.post<JobOut>("/settings/storage/migrate", payload),
  });
}
