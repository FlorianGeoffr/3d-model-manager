/**
 * Automation & scheduling card (Round 10 T5): the General tab's editor for
 * the four background-schedule intervals in the DB-backed `AppSettings`
 * (`GET`/`PUT /settings/app`) -- library scan, collection sync, and the
 * watched-folder poll + stability delay. Mirrors `SiteTokensCard`'s
 * draft/save/alert/"Saved." card conventions.
 *
 * `printer_enabled` isn't edited here (see `PrinterEnabledCard`), but it IS
 * included in every `PUT` body below -- the endpoint is a full replace of
 * all five `AppSettings` fields, not a per-field patch.
 */
import { useEffect, useState } from "react";

import { useAppSettings, useUpdateAppSettings } from "@/api/appSettings";
import { ApiError } from "@/api/client";
import { useFeatures } from "@/api/features";
import type { AppSettings } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

interface Draft {
  scan_interval_s: string;
  collection_sync_interval_s: string;
  watch_interval_s: string;
  watch_stable_s: string;
}

function seedDraft(settings: AppSettings): Draft {
  return {
    scan_interval_s: String(settings.scan_interval_s),
    collection_sync_interval_s: String(settings.collection_sync_interval_s),
    watch_interval_s: String(settings.watch_interval_s),
    watch_stable_s: String(settings.watch_stable_s),
  };
}

export function AutomationCard() {
  const settings = useAppSettings();
  const features = useFeatures();
  const update = useUpdateAppSettings();
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (settings.data && draft === null) setDraft(seedDraft(settings.data));
  }, [settings.data, draft]);

  if (settings.isLoading || draft === null) return <Skeleton className="h-80 w-full rounded-xl" />;

  if (settings.isError || !settings.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Automation &amp; scheduling</CardTitle>
          <CardDescription>
            {settings.error instanceof ApiError ? settings.error.detail : "Couldn't load these settings."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  function setField(key: keyof Draft, value: string) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function save() {
    if (!settings.data || !draft) return;
    update.mutate({
      printer_enabled: settings.data.printer_enabled,
      scan_interval_s: Number(draft.scan_interval_s),
      collection_sync_interval_s: Number(draft.collection_sync_interval_s),
      watch_interval_s: Number(draft.watch_interval_s),
      watch_stable_s: Number(draft.watch_stable_s),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation &amp; scheduling</CardTitle>
        <CardDescription>
          Background schedules run automatically. Set any interval to 0 to turn it off. Changes
          apply within about 15 seconds — no restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scan-interval">Library scan interval (seconds)</Label>
            <Input
              id="scan-interval"
              type="number"
              min={0}
              value={draft.scan_interval_s}
              onChange={(e) => setField("scan_interval_s", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Automatically rescan and reconcile the library. 0 = off; you can still scan on demand.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="collection-sync-interval">Collection sync interval (seconds)</Label>
            <Input
              id="collection-sync-interval"
              type="number"
              min={0}
              value={draft.collection_sync_interval_s}
              onChange={(e) => setField("collection_sync_interval_s", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Refresh followed remote collections. 0 = off; Sync now still works.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="watch-interval">Watched folder poll (seconds)</Label>
            <Input
              id="watch-interval"
              type="number"
              min={0}
              value={draft.watch_interval_s}
              onChange={(e) => setField("watch_interval_s", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How often to import files dropped into the watched folder. 0 = off.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="watch-stable">Watched folder stability delay (seconds)</Label>
            <Input
              id="watch-stable"
              type="number"
              min={0}
              step="any"
              value={draft.watch_stable_s}
              onChange={(e) => setField("watch_stable_s", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A dropped file must sit unchanged this long before import — guards against
              half-written exports.
            </p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          {features.data?.watch_dir
            ? `Watched folder: ${features.data.watch_dir} — maps to WATCH_HOST_DIR on the host.`
            : "No watched folder mounted."}
        </p>

        <div className="flex items-center gap-3">
          <Button type="button" disabled={update.isPending} onClick={save}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
          {update.isSuccess && <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>}
        </div>
        {update.isError && (
          <p role="alert" className="text-sm text-destructive">
            {update.error instanceof ApiError ? update.error.detail : "Could not save these settings."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
