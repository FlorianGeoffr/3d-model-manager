/**
 * Query hook for the dashboard stats endpoint (R11-B item 13):
 * `GET /api/stats` -- cheap aggregates, cached server-side for 30s.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { StatsOut } from "@/api/types";

export const statsQueryOptions = queryOptions({
  queryKey: ["stats"] as const,
  queryFn: () => api.get<StatsOut>("/stats"),
});

export function useStats() {
  return useQuery(statsQueryOptions);
}
