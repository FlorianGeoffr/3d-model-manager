import { ApiError } from "@/api/client";
import { useStorageBackends } from "@/api/settings";
import { BambuAccountCard } from "@/components/settings/BambuAccountCard";
import { PrinterSetupCard } from "@/components/settings/PrinterSetupCard";
import { PrintablesAccountCard } from "@/components/settings/PrintablesAccountCard";
import { ScanReport } from "@/components/settings/ScanReport";
import { SiteTokensCard } from "@/components/settings/SiteTokensCard";
import { StorageBackendsCard } from "@/components/settings/StorageBackendsCard";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function SettingsPage() {
  // The single multi-backend `StorageBackendsCard` is now the ONLY storage UI
  // (the legacy single-backend config card was removed in M8 F); the page
  // shell gates on that same list.
  const backendsQuery = useStorageBackends();

  return (
    <PageContainer width="default">
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
          <TabsContent value="imports" className="grid gap-6 xl:grid-cols-2">
            {/* The two paste-a-credential cards pair up on a wide screen; the
                Bambu login form is itself two columns wide (email/region +
                password), so it takes the full row -- and it goes LAST, since a
                col-span-2 card between two single-column ones cannot fit beside
                either and would strand an empty cell on both rows. */}
            <SiteTokensCard />
            <PrintablesAccountCard />
            <BambuAccountCard className="xl:col-span-2" />
          </TabsContent>
          <TabsContent value="scan" className="space-y-6">
            <ScanReport />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}
