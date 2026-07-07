import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import { ApiError } from "@/api/client";
import { useCreateImport, useImport } from "@/api/imports";
import { detectSite } from "@/lib/importSites";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const TERMINAL = new Set(["done", "failed"]);

export function ImportPage() {
  const [url, setUrl] = useState("");
  const [activeId, setActiveId] = useState<number | undefined>(undefined);
  const createImport = useCreateImport();
  const active = useImport(activeId);

  const detected = useMemo(() => detectSite(url), [url]);
  const canImport = detected.supported && !createImport.isPending;

  function start() {
    createImport.mutate(
      { url: url.trim() },
      { onSuccess: (imp) => setActiveId(imp.id) },
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Import from a gallery</h1>
        <p className="text-sm text-muted-foreground">
          Paste a Thingiverse or Printables model link. Files download into a new model with
          attribution. By importing you confirm the model&apos;s license permits it (personal use,
          one model per action).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Model URL</CardTitle>
          <CardDescription>The site is detected automatically.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-url">URL</Label>
            <Input
              id="import-url"
              value={url}
              placeholder="https://www.printables.com/model/3161-benchy"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          {url.trim() !== "" && detected.site !== null && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Detected:</span>
              <Badge variant={detected.supported ? "secondary" : "outline"}>{detected.label}</Badge>
            </div>
          )}

          {url.trim() !== "" && detected.site === "makerworld" && (
            <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
              MakerWorld import isn&apos;t available yet. Thingiverse and Printables are supported today.
            </p>
          )}
          {url.trim() !== "" && detected.site === null && (
            <p role="alert" className="text-sm text-destructive">
              Unrecognized link — paste a Thingiverse or Printables model URL.
            </p>
          )}

          <Button type="button" onClick={start} disabled={!canImport}>
            {createImport.isPending ? "Starting…" : "Import"}
          </Button>

          {createImport.isError && (
            <p role="alert" className="text-sm text-destructive">
              {createImport.error instanceof ApiError ? createImport.error.detail : "Could not start the import."}
            </p>
          )}
        </CardContent>
      </Card>

      {active.data && <ImportProgress importId={active.data.id} />}
    </div>
  );
}

function ImportProgress({ importId }: { importId: number }) {
  const imp = useImport(importId);
  if (!imp.data) return null;
  const { state, error, model_id } = imp.data;
  const done = TERMINAL.has(state);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import progress</CardTitle>
        <CardDescription>
          {state === "done" ? "Complete." : done ? "Failed." : `${state}…`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!done && (
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div className="h-full w-1/2 animate-pulse rounded bg-primary" />
          </div>
        )}
        {state === "failed" && (
          <p role="alert" className="text-sm text-destructive">{error ?? "Import failed."}</p>
        )}
        {state === "done" && model_id !== null && (
          <Button asChild variant="outline">
            <Link to="/">View library</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
