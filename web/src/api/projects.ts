/**
 * Query/mutation hooks for the projects domain.
 * Projects allow grouping models/parts with manufacturing progress tracking.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { ProjectCreate, ProjectOut, ProjectPatch } from "@/api/types";

export const projectsQueryOptions = queryOptions({
  queryKey: ["projects"] as const,
  queryFn: () => api.get<ProjectOut[]>("/projects"),
});

export function useProjects() {
  return useQuery(projectsQueryOptions);
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ProjectCreate) => api.post<ProjectOut>("/projects", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryOptions.queryKey });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: ProjectPatch }) =>
      api.patch<ProjectOut>(`/projects/${id}`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/projects/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}
