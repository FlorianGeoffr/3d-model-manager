/**
 * Live `/printer` page (M4 Task 8): a status panel per configured printer
 * plus the print-job history, gated on the `printer_enabled` feature flag
 * (`GET /features`). Direct navigation while the flag is off renders a
 * clear disabled state rather than crashing or looking broken.
 */
import { Link } from "@tanstack/react-router";

import { ApiError } from "@/api/client";
import { useFeatures } from "@/api/features";
import { usePrinters } from "@/api/printers";
import { PrintJobHistory } from "@/components/printer/PrintJobHistory";
import { PrinterStatusPanel } from "@/components/printer/PrinterStatusPanel";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";

export function PrinterPage() {
  const features = useFeatures();
  const enabled = !!features.data?.printer_enabled;
  const printers = usePrinters({ enabled });

  if (features.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  if (!enabled)
    return (
      <Card className="mx-auto mt-12 max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Printer integration is off</CardTitle>
          <CardDescription>
            Turn it on under Settings → Printer to connect your Bambu printer over the LAN. It
            takes effect immediately — no restart.
          </CardDescription>
        </CardHeader>
      </Card>
    );

  return (
    <PageContainer width="narrow">
      <h1 className="text-lg font-semibold">Printer</h1>
      {printers.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : printers.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {printers.error instanceof ApiError ? printers.error.detail : "Couldn't load printers."}
        </p>
      ) : printers.data && printers.data.length > 0 ? (
        <>
          {printers.data.map((p) => (
            <PrinterStatusPanel key={p.id} printer={p} />
          ))}
          <PrintJobHistory />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No printer configured. Add one in{" "}
          <Link to="/settings" className="underline">
            Settings
          </Link>
          .
        </p>
      )}
    </PageContainer>
  );
}
