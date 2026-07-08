/**
 * Minimal job-progress polling (Task 7: migrate-job progress). There is no
 * `GET /api/jobs/{id}` yet (Task 6 only shipped the list + retry) -- per the
 * Task 7 brief, the simplest correct thing is polling the list endpoint and
 * picking the one job out of it. This is only ever used for rare,
 * operator-driven jobs (a storage migration), so the O(limit) list fetch on
 * every poll tick is a non-issue.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { JobOut } from "@/api/types";

const POLL_MS = 1500;

export function jobQueryOptions(id: string | undefined) {
  return queryOptions({
    queryKey: ["jobs", "detail", id] as const,
    queryFn: async () => {
      const jobs = await api.get<JobOut[]>("/jobs?limit=200");
      const job = jobs.find((item) => item.id === id);
      if (!job) throw new Error(`job ${id ?? ""} not found`);
      return job;
    },
    enabled: id !== undefined,
  });
}

/** Polls until the job reaches a terminal state (`done`/`failed`), then stops. */
export function useJob(id: string | undefined, options?: { enabled?: boolean }) {
  return useQuery({
    ...jobQueryOptions(id),
    enabled: id !== undefined && (options?.enabled ?? true),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "done" || state === "failed" ? false : POLL_MS;
    },
  });
}

/** Jobs page (Task 9): lists jobs, optionally filtered to a single backend
 * `state` (`app/api/jobs.py`'s `?state=` query param takes one value, not a
 * set -- any "show me failed + dead" client-side narrowing happens in the
 * page, not here). Not polled -- `useEvents.tsx`'s `job.updated` branch
 * invalidates `["jobs"]` on every transition, which is how this list stays
 * live. */
export function useJobs(params: { state?: string } = {}) {
  return useQuery({
    queryKey: ["jobs", "list", params] as const,
    queryFn: () => api.get<JobOut[]>(`/jobs${params.state ? `?state=${params.state}` : ""}`),
  });
}

/** Retries a `failed`/`dead` job (`POST /jobs/{id}/retry`) -- 409s for a
 * job type with no retry path (`migrate_storage`) or a missing subject,
 * surfaced by the caller via `ApiError.detail` (mirrors
 * `PrintJobHistory.tsx`'s error rendering). */
export function useRetryJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<JobOut>(`/jobs/${id}/retry`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
}
