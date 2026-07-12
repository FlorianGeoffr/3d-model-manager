/**
 * Followed remote collections + the review queue (M8 H). Browse the signed-in
 * user's lists on each site, follow one (choosing auto-import vs review), run
 * the sync on demand, and approve/dismiss whatever a review list queued.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type {
  CollectionSyncMode,
  FollowedCollection,
  ImportSite,
  JobOut,
  ImportOut,
  PendingImport,
  RemoteList,
} from "@/api/types";

export const followedQueryOptions = queryOptions({
  queryKey: ["collections"] as const,
  queryFn: () => api.get<FollowedCollection[]>("/collections"),
});

export const pendingQueryOptions = queryOptions({
  queryKey: ["collections", "pending"] as const,
  queryFn: () => api.get<PendingImport[]>("/collections/pending"),
});

/** The user's collections/likes across every site. Empty until a site's
 * authenticated session is wired up -- that's a state, not an error. */
export const remoteListsQueryOptions = queryOptions({
  queryKey: ["imports", "lists"] as const,
  queryFn: () => api.get<RemoteList[]>("/imports/lists"),
});

export function useFollowedCollections() {
  return useQuery(followedQueryOptions);
}

export function usePendingImports() {
  return useQuery(pendingQueryOptions);
}

export function useRemoteLists() {
  return useQuery(remoteListsQueryOptions);
}

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["collections"] });
}

export interface FollowCollectionBody {
  site: ImportSite;
  list_id: string;
  kind: string;
  title: string;
  mode?: CollectionSyncMode;
}

export function useFollowCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FollowCollectionBody) => api.post<FollowedCollection>("/collections", body),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export interface FollowCollectionByUrlBody {
  url: string;
}

/** M10 escape hatch B: follow a MakerWorld collection by pasting its URL
 * (`POST /collections/from-url`) instead of picking it off `useRemoteLists`'
 * browsable list -- the SSR route that would otherwise enumerate it is
 * intermittently Cloudflare-walled. Always uses the endpoint's default mode
 * (`review`); invalidates the same `["collections"]` key `useFollowCollection`
 * does, so the new follow shows up in the "Followed collections" list. */
export function useFollowCollectionByUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FollowCollectionByUrlBody) =>
      api.post<FollowedCollection>("/collections/from-url", body),
    onSuccess: () => invalidateAll(queryClient),
  });
}

export function useUnfollowCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/collections/${id}`),
    onSuccess: () => {
      invalidateAll(queryClient);
      // Unfollowing nulls `source_collection_id` on the collection's models
      // (FK ON DELETE SET NULL) -- refetch so ProvenanceBlock/RelatedModels
      // drop the now-dead collection link instead of showing stale data.
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useSetCollectionMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode }: { id: number; mode: CollectionSyncMode }) =>
      api.patch<FollowedCollection>(`/collections/${id}`, { mode }),
    onSuccess: () => invalidateAll(queryClient),
  });
}

/** Runs the sync immediately (the beat schedule is opt-in). Returns the Job. */
export function useSyncCollectionsNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<JobOut>("/collections/sync"),
    onSuccess: () => {
      invalidateAll(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useApprovePending() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<ImportOut>(`/collections/pending/${id}/approve`),
    onSuccess: () => {
      invalidateAll(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      // Approving mints a new Import row (import-health task T3) --
      // invalidate so it shows up in the "Recent imports" card right away
      // rather than waiting on the next SSE tick/poll.
      void queryClient.invalidateQueries({ queryKey: ["imports"] });
    },
  });
}

export function useDismissPending() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/collections/pending/${id}`),
    onSuccess: () => invalidateAll(queryClient),
  });
}
