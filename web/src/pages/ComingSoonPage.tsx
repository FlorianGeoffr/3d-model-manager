import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ComingSoonPage({ title }: { title: string }) {
  return (
    <Card className="mx-auto mt-12 max-w-md">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Coming in M2+</CardDescription>
      </CardHeader>
    </Card>
  );
}
