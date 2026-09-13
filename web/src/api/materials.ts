/**
 * Query/mutation hooks for the materials domain (R13c): filament profiles a
 * print can reference (`PrintEntry.material_id`), in addition to the
 * freeform `filament` text note. Mirrors `categories.ts`'s hooks shape.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { MaterialCreate, MaterialOut, MaterialPatch } from "@/api/types";

export const materialsQueryOptions = queryOptions({
  queryKey: ["materials"] as const,
  queryFn: () => api.get<MaterialOut[]>("/materials"),
});

export function useMaterials() {
  return useQuery(materialsQueryOptions);
}

export function useCreateMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: MaterialCreate) => api.post<MaterialOut>("/materials", payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: materialsQueryOptions.queryKey }),
  });
}

export function useUpdateMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: MaterialPatch }) =>
      api.patch<MaterialOut>(`/materials/${id}`, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: materialsQueryOptions.queryKey }),
  });
}

export function useDeleteMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/materials/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: materialsQueryOptions.queryKey }),
  });
}
