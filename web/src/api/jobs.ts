/**
 * Minimal job-progress polling (Task 7: migrate-job progress). There is no
 * `GET /api/jobs/{id}` yet (Task 6 only shipped the list + retry) -- per the
 * Task 7 brief, the simplest correct thing is polling the list endpoint and
 * picking the one job out of it. This is only ever used for rare,
 * operator-driven jobs (a storage migration), so the O(limit) list fetch on
 * every poll tick is a non-issue.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";

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
