/**
 * Query/mutation hooks for the storage-settings domain (Task 7): read/set
 * the active storage backend config, probe a candidate config, and kick off
 * the copy+verify+cutover migration job. Mirrors `library.ts`'s shape.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  ConnectionTestOut,
  JobOut,
  StorageBackendCreateIn,
  StorageBackendOut,
  StorageBackendUpdateIn,
  StorageConfigOut,
} from "@/api/types";

export const storageConfigQueryOptions = queryOptions({
  queryKey: ["settings", "storage"] as const,
  queryFn: () => api.get<StorageConfigOut>("/settings/storage"),
});

export function useStorageConfig() {
  return useQuery(storageConfigQueryOptions);
}

// ---------------------------------------------------------------------------
// Multi-backend storage CRUD (Workstream C task C4 UI): the full
// `storage_backends` table -- add/edit/remove backends, test any one of
// them, and flip which one is the write-default. Distinct from the
// hooks above, which manage the legacy single-backend shim.
// ---------------------------------------------------------------------------

export const storageBackendsQueryOptions = queryOptions({
  queryKey: ["settings", "storage", "backends"] as const,
  queryFn: () => api.get<StorageBackendOut[]>("/settings/storage/backends"),
});

export function useStorageBackends() {
  return useQuery(storageBackendsQueryOptions);
}

function invalidateBackends(queryClient: ReturnType<typeof useQueryClient>) {
  return void queryClient.invalidateQueries({ queryKey: storageBackendsQueryOptions.queryKey });
}

export function useCreateBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: StorageBackendCreateIn) =>
      api.post<StorageBackendOut>("/settings/storage/backends", payload),
    onSuccess: () => invalidateBackends(queryClient),
  });
}

export function useUpdateBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: StorageBackendUpdateIn }) =>
      api.put<StorageBackendOut>(`/settings/storage/backends/${id}`, payload),
    onSuccess: () => invalidateBackends(queryClient),
  });
}

export function useDeleteBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/settings/storage/backends/${id}`),
    onSuccess: () => invalidateBackends(queryClient),
  });
}

/** Probes an already-saved backend row's connection by id. */
export function useTestBackend() {
  return useMutation({
    mutationFn: (id: number) => api.post<ConnectionTestOut>(`/settings/storage/backends/${id}/test`),
  });
}

export function useSetDefaultBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<StorageBackendOut>(`/settings/storage/backends/${id}/default`),
    onSuccess: () => invalidateBackends(queryClient),
  });
}

/** "Move all models here" (M8 F): sets this backend as the write-default AND
 * relocates the whole library onto it (a job), replacing the legacy
 * whole-library migrate. */
export function useMigrateToBackend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<JobOut>(`/settings/storage/backends/${id}/migrate`),
    onSuccess: () => invalidateBackends(queryClient),
  });
}
