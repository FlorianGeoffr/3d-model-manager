/**
 * Query/mutation hooks for the Bambu Lab account connect flow (Workstream B
 * task B2 backend / B3 frontend): read connection status, log in (which may
 * land on an MFA challenge instead of connecting outright), complete MFA
 * verification, and disconnect. Mirrors `settings.ts`'s `queryOptions`/
 * mutation shape. Connecting an account powers MakerWorld's authenticated
 * search + file downloads -- anonymous MakerWorld access only sees trending
 * results and can't download files (see `app/services/bambu_auth.py`).
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { BambuLoginIn, BambuLoginOut, BambuStatusOut, BambuVerifyIn } from "@/api/types";

export const bambuStatusQueryOptions = queryOptions({
  queryKey: ["settings", "bambu"] as const,
  queryFn: () => api.get<BambuStatusOut>("/settings/bambu"),
});

export function useBambuStatus() {
  return useQuery(bambuStatusQueryOptions);
}

export function useBambuLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BambuLoginIn) => api.post<BambuLoginOut>("/settings/bambu/login", body),
    onSuccess: (data) => {
      if (data.status === "connected") void qc.invalidateQueries({ queryKey: bambuStatusQueryOptions.queryKey });
    },
  });
}

export function useBambuVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BambuVerifyIn) => api.post<BambuLoginOut>("/settings/bambu/verify", body),
    onSuccess: (data) => {
      if (data.status === "connected") void qc.invalidateQueries({ queryKey: bambuStatusQueryOptions.queryKey });
    },
  });
}

export function useBambuDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/settings/bambu"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: bambuStatusQueryOptions.queryKey }),
  });
}
