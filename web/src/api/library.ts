/**
 * Query/mutation hooks for the library domain (models, revisions, tags,
 * notes, files) — Task 8.
 */
import { queryOptions, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  DiffResponse,
  GalleryPage,
  JobOut,
  ModelCreate,
  ModelDetail,
  ModelPatch,
  ModelRelocateIn,
  NoteCreate,
  NoteOut,
  RevisionCreate,
  RevisionDetail,
  RevisionSummary,
  TagOut,
} from "@/api/types";

export interface GalleryFilters {
  q?: string;
  tag?: string;
  format?: string;
  has_sliced?: boolean;
  collection?: number;
  sort: string;
}

const GALLERY_PAGE_SIZE = 24;

function buildModelsUrl(filters: Partial<GalleryFilters>, cursor?: string, limit = GALLERY_PAGE_SIZE): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.format) params.set("format", filters.format);
  if (filters.has_sliced) params.set("has_sliced", "true");
  if (filters.collection !== undefined) params.set("collection", String(filters.collection));
  if (filters.sort) params.set("sort", filters.sort);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return `/models?${params.toString()}`;
}

/** Gallery grid — cursor-paginated via `useInfiniteQuery` (Task 8 decision). */
export function useModelsQuery(filters: GalleryFilters) {
  return useInfiniteQuery({
    queryKey: ["models", "list", filters] as const,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      api.get<GalleryPage>(buildModelsUrl(filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

/** Lightweight model search used by the upload page's "existing model" picker. */
export function useModelSearchQuery(q: string) {
  return useQuery({
    queryKey: ["models", "search", q] as const,
    queryFn: () => api.get<GalleryPage>(buildModelsUrl({ q, sort: "name" }, undefined, 10)),
    enabled: q.trim().length > 0,
  });
}

/** The model detail page's "More from <collection>" strip (Task 2, collection
 * provenance) -- a small, non-paginated peek at a few other models imported
 * from the same followed collection. Disabled when the model has no
 * `source_collection_id` (manually created, or imported outside a followed
 * collection). */
export function useRelatedModelsQuery(collectionId: number | undefined) {
  return useQuery({
    queryKey: ["models", "related", collectionId] as const,
    queryFn: () => api.get<GalleryPage>(buildModelsUrl({ collection: collectionId }, undefined, 6)),
    enabled: collectionId !== undefined,
  });
}

export function modelQueryOptions(slug: string) {
  return queryOptions({
    queryKey: ["models", "detail", slug] as const,
    queryFn: () => api.get<ModelDetail>(`/models/${encodeURIComponent(slug)}`),
    enabled: slug.length > 0,
  });
}

export function useModel(slug: string) {
  return useQuery(modelQueryOptions(slug));
}

export function useCreateModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ModelCreate) => api.post<ModelDetail>("/models", payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["models", "list"] }),
  });
}

export function usePatchModel(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ModelPatch) => api.patch<ModelDetail>(`/models/${slug}`, payload),
    onSuccess: (data) => {
      queryClient.setQueryData(modelQueryOptions(slug).queryKey, data);
      void queryClient.invalidateQueries({ queryKey: ["models", "list"] });
    },
  });
}

export function useArchiveModel(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/models/${slug}`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: modelQueryOptions(slug).queryKey });
      void queryClient.invalidateQueries({ queryKey: ["models", "list"] });
    },
  });
}

/** Dispatches `POST /models/{slug}/relocate` (Workstream C task C3/C4) to
 * move or replicate every file of this model, across all its revisions,
 * onto another configured backend. Returns the tracked `JobOut` -- no
 * explicit invalidation here: `useEvents.tsx`'s `job.updated` handler
 * already invalidates `["models"]` on every job's terminal state, which is
 * how `model.backends` (Part 1) picks up a completed "move". */
export function useRelocateModel(slug: string) {
  return useMutation({
    mutationFn: (payload: ModelRelocateIn) =>
      api.post<JobOut>(`/models/${encodeURIComponent(slug)}/relocate`, payload),
  });
}

export const tagsQueryOptions = queryOptions({
  queryKey: ["tags"] as const,
  queryFn: () => api.get<TagOut[]>("/tags"),
});

export function useTags() {
  return useQuery(tagsQueryOptions);
}

export function useAddTag(slug: string, modelId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<TagOut>(`/models/${modelId}/tags`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey });
      void queryClient.invalidateQueries({ queryKey: tagsQueryOptions.queryKey });
    },
  });
}

export function useRemoveTag(slug: string, modelId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete<void>(`/models/${modelId}/tags/${encodeURIComponent(name)}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey }),
  });
}

export function useRevisions(modelId: number | undefined) {
  return useQuery({
    queryKey: ["revisions", modelId] as const,
    queryFn: () => api.get<RevisionSummary[]>(`/models/${modelId}/revisions`),
    enabled: modelId !== undefined,
  });
}

export function useCreateRevision(slug: string, modelId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: RevisionCreate) =>
      api.post<RevisionDetail>(`/models/${modelId}/revisions`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey });
      void queryClient.invalidateQueries({ queryKey: ["revisions", modelId] });
    },
  });
}

export function useRevisionDiff(aId: number | undefined, bId: number | undefined) {
  return useQuery({
    queryKey: ["diff", aId, bId] as const,
    queryFn: () => api.get<DiffResponse>(`/revisions/${aId}/diff/${bId}`),
    enabled: aId !== undefined && bId !== undefined,
  });
}

/** `GET /revisions/{id}` — the only endpoint that returns a revision's own
 * notes (`RevisionSummary`, used for the history list, doesn't carry them). */
export function revisionDetailQueryOptions(revisionId: number) {
  return queryOptions({
    queryKey: ["revisions", "detail", revisionId] as const,
    queryFn: () => api.get<RevisionDetail>(`/revisions/${revisionId}`),
  });
}

export function useRevisionDetail(revisionId: number) {
  return useQuery(revisionDetailQueryOptions(revisionId));
}

/** Per-revision note mutations — same `/notes` endpoints as the model-level
 * hooks below, but invalidating the revision detail query (which is where
 * a revision's notes actually live) instead of the model query. */
export function useCreateRevisionNote(revisionId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NoteCreate) => api.post<NoteOut>(`/notes`, payload),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: revisionDetailQueryOptions(revisionId).queryKey }),
  });
}

export function usePatchRevisionNote(revisionId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => api.patch<NoteOut>(`/notes/${id}`, { body }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: revisionDetailQueryOptions(revisionId).queryKey }),
  });
}

export function useDeleteRevisionNote(revisionId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/notes/${id}`),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: revisionDetailQueryOptions(revisionId).queryKey }),
  });
}

export function useCreateNote(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: NoteCreate) => api.post(`/notes`, payload),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey }),
  });
}

export function usePatchNote(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: string }) => api.patch(`/notes/${id}`, { body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey }),
  });
}

export function useDeleteNote(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/notes/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey }),
  });
}

export function useDeleteFile(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/files/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: modelQueryOptions(slug).queryKey }),
  });
}
