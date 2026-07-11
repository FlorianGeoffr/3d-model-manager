import { Link } from "@tanstack/react-router";

import { ApiError } from "@/api/client";
import { useStorageBackends } from "@/api/settings";
import { BambuAccountCard } from "@/components/settings/BambuAccountCard";
import { BrowserExtensionCard } from "@/components/settings/BrowserExtensionCard";
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
          <TabsContent value="imports" className="space-y-6">
            {/* Signpost, kept OUTSIDE the cards grid below: users connect an
                account here and then look for its collections nearby. They
                live on their own page, so say so -- and adding this as a 5th
                grid item would have broken the packing worked out below. */}
            <p className="text-sm text-muted-foreground">
              Connect your gallery accounts here. The collections they hold appear under{" "}
              <Link to="/collections" className="underline">
                Collections
              </Link>
              , where you pick which ones to keep synced.
            </p>
            <div className="grid gap-6 xl:grid-cols-2">
              {/* Sparse grid auto-placement never backfills: a col-span-2 card
                  only avoids stranding a cell if it starts an EVEN number of
                  single-column cards in. With three single-column cards, a
                  double placed after all three (the naive "keep it last")
                  strands BrowserExtensionCard's row -- confirmed by rendering
                  both orders. Placing the Bambu login form (two columns wide:
                  email/region + password) right after the first pair keeps
                  every row packed; BrowserExtensionCard trails alone in its
                  own final row, which is a normal odd-item tail, not a strand
                  (nothing sits below it to sandwich a gap). */}
              <SiteTokensCard />
              <PrintablesAccountCard />
              <BambuAccountCard className="xl:col-span-2" />
              <BrowserExtensionCard />
            </div>
          </TabsContent>
          <TabsContent value="scan" className="space-y-6">
            <ScanReport />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}
