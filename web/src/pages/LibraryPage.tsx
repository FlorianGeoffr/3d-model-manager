import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Gallery placeholder — the real infinite-scroll grid lands in Task 8. */
export function LibraryPage() {
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>Library</CardTitle>
        <CardDescription>The model gallery lands here in Task 8.</CardDescription>
      </CardHeader>
    </Card>
  );
}
