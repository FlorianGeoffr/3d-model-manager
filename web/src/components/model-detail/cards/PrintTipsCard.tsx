import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

/** Right-column placeholder card (R13a) -- print tips (freeform per-model
 * notes on how to best print the thing) don't have a data model yet; that
 * lands in R13c's `models.print_tips` column + `MetadataEditor`. Disabled
 * so it reads as "not yet wired up" rather than a broken text field. */
export function PrintTipsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Print tips</CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          disabled
          placeholder="Print tips are coming in R13c."
          rows={3}
          aria-label="Print tips"
        />
      </CardContent>
    </Card>
  );
}
