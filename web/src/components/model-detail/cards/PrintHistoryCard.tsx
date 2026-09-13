import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PrintsTab } from "@/components/model-detail/PrintsTab";
import type { ModelDetail } from "@/api/types";

/** Right-column card wrapping `PrintsTab` (R13a) -- `PrintsTab` already
 * renders its own "Log a print" composer at the top of the body, so there's
 * no separate header action slot to wire up here. */
export function PrintHistoryCard({ model }: { model: ModelDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Print history</CardTitle>
      </CardHeader>
      <CardContent>
        <PrintsTab model={model} />
      </CardContent>
    </Card>
  );
}
