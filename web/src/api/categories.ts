/**
 * Query/mutation hooks for the categories domain (R13b): a model has at most
 * one category (exclusive grouping, unlike many-per-model tags). Mirrors
 * `library.ts`'s tag hooks shape.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { CategoryCreate, CategoryOut, CategoryPatch } from "@/api/types";

export const categoriesQueryOptions = queryOptions({
  queryKey: ["categories"] as const,
  queryFn: () => api.get<CategoryOut[]>("/categories"),
});

export function useCategories() {
  return useQuery(categoriesQueryOptions);
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CategoryCreate) => api.post<CategoryOut>("/categories", payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: categoriesQueryOptions.queryKey }),
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: CategoryPatch }) =>
      api.patch<CategoryOut>(`/categories/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: categoriesQueryOptions.queryKey });
      // A category's name/color also shows up denormalized on cached
      // model list/detail queries (`ModelSummary.category`) -- simplest to
      // just refetch those rather than patch every cache entry by hand.
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/categories/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: categoriesQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}
