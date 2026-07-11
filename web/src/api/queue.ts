/**
 * Print queue (backend/app/schemas/queue.py, Branch 4 Task 1): an ordered
 * "models to print" worklist. Mirrors `library.ts`'s hook conventions --
 * `useQuery`/`useMutation` + `queryClient.invalidateQueries`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { QueueEntry } from "@/api/types";

const queueQueryKey = ["queue"] as const;

/** The whole queue, ordered by position (1-based). */
export function useQueue() {
  return useQuery({
    queryKey: queueQueryKey,
    queryFn: () => api.get<QueueEntry[]>("/queue"),
  });
}

/** `POST /queue` -- appends a model to the end of the queue. Idempotent:
 * the backend answers 200 (not 201) if the model is already queued instead
 * of erroring or duplicating it -- either way this resolves, so callers
 * don't need to special-case "already queued" as a failure. */
export function useEnqueueModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: number) => api.post<QueueEntry>("/queue", { model_id: modelId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queueQueryKey }),
  });
}

export function useRemoveQueueEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: number) => api.delete<void>(`/queue/${entryId}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queueQueryKey }),
  });
}

/** `PATCH /queue/{entry_id}` -- moves the entry to a 1-based `position`
 * (clamped server-side to `[1, n]`), returning the whole reordered queue. */
export function useMoveQueueEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ entryId, position }: { entryId: number; position: number }) =>
      api.patch<QueueEntry[]>(`/queue/${entryId}`, { position }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queueQueryKey }),
  });
}
