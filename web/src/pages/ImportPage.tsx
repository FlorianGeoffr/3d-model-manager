import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ImageIcon } from "lucide-react";

import { ApiError } from "@/api/client";
import { useCreateImport, useImport, useImportSearch } from "@/api/imports";
import type { ImportSite, SearchResult } from "@/api/types";
import { detectSite } from "@/lib/importSites";
import { useDebouncedValue } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TERMINAL = new Set(["done", "failed"]);

const SITE_OPTIONS: ReadonlyArray<{ value: ImportSite; label: string }> = [
  { value: "thingiverse", label: "Thingiverse" },
  { value: "printables", label: "Printables" },
  { value: "makerworld", label: "MakerWorld" },
];

export function ImportPage() {
  const [activeId, setActiveId] = useState<number | undefined>(undefined);
  const active = useImport(activeId);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Import from a gallery</h1>
        <p className="text-sm text-muted-foreground">
          Paste a model link or search a site from inside the app. Files download into a new model
          with attribution. By importing you confirm the model&apos;s license permits it (personal
          use, one model per action).
        </p>
      </div>

      <Tabs defaultValue="url">
        <TabsList>
          <TabsTrigger value="url">Paste URL</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
        </TabsList>
        <TabsContent value="url">
          <UrlImportCard onImportStarted={setActiveId} />
        </TabsContent>
        <TabsContent value="search">
          <SearchImportCard onImportStarted={setActiveId} />
        </TabsContent>
      </Tabs>

      {active.data && <ImportProgress importId={active.data.id} />}
    </div>
  );
}

function UrlImportCard({ onImportStarted }: { onImportStarted: (id: number) => void }) {
  const [url, setUrl] = useState("");
  const createImport = useCreateImport();

  const detected = useMemo(() => detectSite(url), [url]);
  const canImport = detected.supported && !createImport.isPending;

  function start() {
    createImport.mutate(
      { url: url.trim() },
      { onSuccess: (imp) => onImportStarted(imp.id) },
    );
  }

  return (
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

        {url.trim() !== "" && detected.site === null && (
          <p role="alert" className="text-sm text-destructive">
            Unrecognized link — paste a Thingiverse, Printables, or MakerWorld model URL.
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
  );
}

function SearchImportCard({ onImportStarted }: { onImportStarted: (id: number) => void }) {
  const [site, setSite] = useState<ImportSite>("thingiverse");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const results = useImportSearch(site, debouncedQuery);
  const createImport = useCreateImport();
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  function addToLibrary(result: SearchResult) {
    setPendingUrl(result.url);
    createImport.mutate(
      { url: result.url },
      {
        onSuccess: (imp) => {
          setPendingUrl(null);
          onImportStarted(imp.id);
        },
        onError: () => setPendingUrl(null),
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search a gallery</CardTitle>
        <CardDescription>Browse a site&apos;s models and import one without leaving the app.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="search-site">Site</Label>
            <Select value={site} onValueChange={(value) => setSite(value as ImportSite)}>
              <SelectTrigger id="search-site" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SITE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="search-query">Search query</Label>
            <Input
              id="search-query"
              value={query}
              placeholder="Search models…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {site === "makerworld" && (
          <p className="text-sm text-muted-foreground">
            Accurate MakerWorld search and downloads need a connected Bambu account (
            <Link to="/settings" className="underline">
              Settings
            </Link>
            ). Without one, search only returns trending results and downloads are gated.
          </p>
        )}

        {query.trim() === "" ? (
          <p className="text-sm text-muted-foreground">Type to search.</p>
        ) : results.isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-44 w-full rounded-lg" />
            ))}
          </div>
        ) : results.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {results.error instanceof ApiError ? results.error.detail : "Search failed."}
          </p>
        ) : (results.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No results for &quot;{debouncedQuery}&quot;.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(results.data ?? []).map((result) => (
              <SearchResultCard
                key={`${result.site}-${result.external_id}`}
                result={result}
                busy={createImport.isPending && pendingUrl === result.url}
                onAdd={() => addToLibrary(result)}
              />
            ))}
          </div>
        )}

        {createImport.isError && (
          <p role="alert" className="text-sm text-destructive">
            {createImport.error instanceof ApiError ? createImport.error.detail : "Could not start the import."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SearchResultCard({
  result,
  busy,
  onAdd,
}: {
  result: SearchResult;
  busy: boolean;
  onAdd: () => void;
}) {
  const [imgErrored, setImgErrored] = useState(false);
  const showThumb = result.thumbnail_url !== null && !imgErrored;

  return (
    <Card className="gap-2 overflow-hidden" size="sm">
      <div className="flex aspect-square items-center justify-center bg-muted">
        {showThumb ? (
          <img
            src={result.thumbnail_url ?? undefined}
            alt={result.title}
            className="h-full w-full object-cover"
            onError={() => setImgErrored(true)}
          />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" />
        )}
      </div>
      <CardContent className="flex flex-col gap-1.5">
        <h3 className="truncate text-sm font-medium" title={result.title}>
          {result.title}
        </h3>
        {result.author && <p className="truncate text-xs text-muted-foreground">by {result.author}</p>}
        <Button type="button" size="sm" disabled={busy} onClick={onAdd}>
          {busy ? "Adding…" : "Add to library"}
        </Button>
      </CardContent>
    </Card>
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
