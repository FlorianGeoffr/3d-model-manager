import { ApiError } from "@/api/client";
import { useStorageBackends } from "@/api/settings";
import { BambuAccountCard } from "@/components/settings/BambuAccountCard";
import { PrinterSetupCard } from "@/components/settings/PrinterSetupCard";
import { ScanReport } from "@/components/settings/ScanReport";
import { SiteTokensCard } from "@/components/settings/SiteTokensCard";
import { StorageBackendsCard } from "@/components/settings/StorageBackendsCard";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function SettingsPage() {
  // The single multi-backend `StorageBackendsCard` is now the ONLY storage UI
  // (the legacy single-backend config card was removed in M8 F); the page
  // shell gates on that same list.
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
