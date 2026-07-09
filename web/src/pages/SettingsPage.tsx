import { useEffect, useState } from "react";

import { ApiError } from "@/api/client";
import { useJob } from "@/api/jobs";
import {
  useMigrateStorage,
  useStorageBackends,
  useStorageConfig,
  useTestConnection,
  useUpdateStorageConfig,
} from "@/api/settings";
import type { StorageConfigIn, StorageConfigOut } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  missingRequiredFields,
  seedDraft,
  StorageBackendForm,
  stripBlankSecrets,
} from "@/components/settings/StorageBackendForm";
import { BambuAccountCard } from "@/components/settings/BambuAccountCard";
import { PrinterSetupCard } from "@/components/settings/PrinterSetupCard";
import { ScanReport } from "@/components/settings/ScanReport";
import { SiteTokensCard } from "@/components/settings/SiteTokensCard";
import { StorageBackendsCard } from "@/components/settings/StorageBackendsCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function SettingsPage() {
  // The page shell now gates on the multi-backend list (the legacy
  // single-backend config query is owned by StorageSettingsCard itself), so
  // removing that legacy card later doesn't strand the page loader.
  const backendsQuery = useStorageBackends();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Storage backends, printer, import accounts, and library scans.
        </p>
      </div>

      {backendsQuery.isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : backendsQuery.isError ? (
        <Card className="mx-auto mt-12 max-w-md">
          <CardHeader className="items-center text-center">
            <CardTitle>Couldn&apos;t load settings</CardTitle>
            <CardDescription>
              {backendsQuery.error instanceof ApiError ? backendsQuery.error.detail : "Something went wrong."}
            </CardDescription>
          </CardHeader>
          <div className="flex justify-center pb-4">
            <Button type="button" onClick={() => void backendsQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : (
        <Tabs defaultValue="storage">
          <TabsList>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <TabsTrigger value="printer">Printer</TabsTrigger>
            <TabsTrigger value="imports">Imports</TabsTrigger>
            <TabsTrigger value="scan">Scan</TabsTrigger>
          </TabsList>
          <TabsContent value="storage" className="space-y-6">
            <StorageSettingsCard />
            <StorageBackendsCard />
          </TabsContent>
          <TabsContent value="printer" className="space-y-6">
            <PrinterSetupCard />
          </TabsContent>
          <TabsContent value="imports" className="space-y-6">
            <SiteTokensCard />
            <BambuAccountCard />
          </TabsContent>
          <TabsContent value="scan" className="space-y-6">
            <ScanReport />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/** Legacy single-backend storage form. Self-fetches its config so the page
 * shell no longer depends on ``useStorageConfig`` (Workstream F removes this
 * card entirely, leaving the multi-backend ``StorageBackendsCard``). */
function StorageSettingsCard() {
  const configQuery = useStorageConfig();

  if (!configQuery.data) {
    // No title text here: the loaded form owns the "Storage backend" heading,
    // so callers awaiting that heading wait for the real form, not this stub.
    return (
      <Card>
        <CardContent className="py-6">
          <Skeleton className="h-40 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  return <StorageSettingsForm active={configQuery.data} />;
}

function StorageSettingsForm({ active }: { active: StorageConfigOut }) {
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
