/**
 * Query/mutation hooks for the DB-backed runtime settings (Round 10 T1):
 * `GET`/`PUT /settings/app` -- the printer toggle and the four background
 * schedule intervals, editable from Settings without an env var or restart.
 *
 * The `["features"]` query (`api/features.ts`) is deliberately pinned at
 * `staleTime: Infinity` -- it's meant to be read once and never auto-refetch.
 * `useUpdateAppSettings` therefore MUST invalidate it explicitly on every
 * successful save, or every consumer that reads it (AppShell's nav,
 * PrinterPage, PrinterSetupCard, SendToPrinterButton, QueuePage,
 * SlicerIntegrationCard) would keep showing stale flags until a full page
 * reload -- this is the landmine to not step on.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import { featuresQueryOptions } from "@/api/features";
import type { AppSettings } from "@/api/types";

export const appSettingsQueryOptions = queryOptions({
  queryKey: ["settings", "app"] as const,
  queryFn: () => api.get<AppSettings>("/settings/app"),
});

export function useAppSettings() {
  return useQuery(appSettingsQueryOptions);
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AppSettings) => api.put<AppSettings>("/settings/app", body),
    onSuccess: (data) => {
      queryClient.setQueryData(appSettingsQueryOptions.queryKey, data);
      void queryClient.invalidateQueries({ queryKey: featuresQueryOptions.queryKey });
    },
  });
}
