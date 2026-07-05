import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ViewerTab() {
  return (
    <Card className="mx-auto mt-8 max-w-md">
      <CardHeader className="items-center text-center">
        <CardTitle>3D viewer</CardTitle>
        <CardDescription>Viewer arrives in M2.</CardDescription>
      </CardHeader>
    </Card>
  );
}
