import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Upload placeholder — the drag-drop queue lands in Task 8. */
export function UploadPage() {
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>Upload</CardTitle>
        <CardDescription>File uploads land here in Task 8.</CardDescription>
      </CardHeader>
    </Card>
  );
}
