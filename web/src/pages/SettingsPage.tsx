import { useEffect, useState } from "react";

import { ApiError } from "@/api/client";
import { useJob } from "@/api/jobs";
import { useMigrateStorage, useStorageConfig, useTestConnection, useUpdateStorageConfig } from "@/api/settings";
import type { StorageConfigIn, StorageConfigOut } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  missingRequiredFields,
  seedDraft,
  StorageBackendForm,
  stripBlankSecrets,
} from "@/components/settings/StorageBackendForm";
import { ScanReport } from "@/components/settings/ScanReport";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SettingsPage() {
  const configQuery = useStorageConfig();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure where the library&apos;s files are stored.</p>
      </div>

      {configQuery.isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : configQuery.isError ? (
        <Card className="mx-auto mt-12 max-w-md">
          <CardHeader className="items-center text-center">
            <CardTitle>Couldn&apos;t load storage settings</CardTitle>
            <CardDescription>
              {configQuery.error instanceof ApiError ? configQuery.error.detail : "Something went wrong."}
            </CardDescription>
          </CardHeader>
          <div className="flex justify-center pb-4">
            <Button type="button" onClick={() => void configQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : configQuery.data ? (
        <>
          <StorageSettingsCard active={configQuery.data} />
          <ScanReport />
        </>
      ) : null}
    </div>
  );
}

function StorageSettingsCard({ active }: { active: StorageConfigOut }) {
  const [draft, setDraft] = useState<StorageConfigIn>(() => seedDraft(active));
  const [migrateJobId, setMigrateJobId] = useState<string | undefined>(undefined);

  const updateConfig = useUpdateStorageConfig();
  const testConnection = useTestConnection();
  const migrateStorage = useMigrateStorage();
  const migrateJob = useJob(migrateJobId);

  // Re-seed the draft whenever the server's active config changes (initial
  // load, or after a Save/Migrate commits a new one) -- otherwise a stale
  // draft would keep showing edits the server no longer reflects, and any
  // secret field would still be holding the pre-seed "***" sentinel.
  useEffect(() => {
    setDraft(seedDraft(active));
  }, [active]);

  const missing = missingRequiredFields(draft, active);
  const isReady = missing.length === 0;
  const busy = updateConfig.isPending || testConnection.isPending || migrateStorage.isPending;

  function payload(): StorageConfigIn {
    return stripBlankSecrets(draft);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage backend</CardTitle>
        <CardDescription>
          Currently active: <span className="font-medium text-foreground">{active.backend}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <StorageBackendForm value={draft} onChange={setDraft} disabled={busy} />

        {!isReady ? (
          <p role="alert" className="text-sm text-destructive">
            Fill in: {missing.join(", ")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || !isReady}
            onClick={() => updateConfig.mutate(payload())}
          >
            {updateConfig.isPending ? "Saving..." : "Save configuration"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !isReady}
            onClick={() => testConnection.mutate(payload())}
          >
            {testConnection.isPending ? "Testing..." : "Test connection"}
          </Button>
        </div>

        {updateConfig.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {updateConfig.error instanceof ApiError ? updateConfig.error.detail : "Could not save configuration"}
          </p>
        ) : null}
        {updateConfig.isSuccess ? (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p>
        ) : null}

        {testConnection.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {testConnection.error instanceof ApiError ? testConnection.error.detail : "Could not test connection"}
          </p>
        ) : null}
        {testConnection.data ? (
          <p
            role={testConnection.data.ok ? undefined : "alert"}
            className={
              testConnection.data.ok
                ? "text-sm text-emerald-600 dark:text-emerald-400"
                : "text-sm text-destructive"
            }
          >
            {testConnection.data.detail} ({testConnection.data.latency_ms} ms)
          </p>
        ) : null}

        <div className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-semibold text-foreground">Migrate library to this backend</h2>
          <ConfirmDialog
            trigger={
              <Button type="button" variant="destructive" disabled={busy || !isReady}>
                {migrateStorage.isPending ? "Starting migration..." : "Migrate library to this backend"}
              </Button>
            }
            title="Migrate library to this backend?"
            description="Copies every library file to the new backend, verifies hashes, then switches over. The old library is left in place."
            confirmLabel="Migrate"
            destructive
            onConfirm={() => migrateStorage.mutate(payload(), { onSuccess: (job) => setMigrateJobId(job.id) })}
          />

          {migrateStorage.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {migrateStorage.error instanceof ApiError ? migrateStorage.error.detail : "Could not start migration"}
            </p>
          ) : null}

          {migrateJob.data ? (
            <p
              role={migrateJob.data.state === "failed" ? "alert" : undefined}
              className={
                migrateJob.data.state === "failed" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
              }
            >
              Migration {migrateJob.data.state}
              {migrateJob.data.error ? `: ${migrateJob.data.error}` : ""}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
