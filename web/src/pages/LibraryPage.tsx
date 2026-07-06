import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";

import { useModelsQuery, useTags } from "@/api/library";
import { ApiError } from "@/api/client";
import { ModelCard } from "@/components/gallery/ModelCard";
import { NewModelDialog } from "@/components/gallery/NewModelDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/lib/format";
import { BLOB_FORMATS, type BlobFormat } from "@/api/types";
import { FORMAT_LABELS } from "@/lib/formatMeta";

const SORT_OPTIONS = [
  { value: "-updated_at", label: "Recently updated" },
  { value: "name", label: "Name" },
] as const;

export function LibraryPage() {
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [activeTag, setActiveTag] = useState<string | undefined>(undefined);
  // The backend's `format` filter accepts a single value (SPEC "API
  // surface") -- a `RadioGroup` (with an "All" item to clear it) is the
  // honest single-select control, replacing the earlier checkbox list that
  // merely behaved like one (Task 9 backlog fold).
  const [activeFormat, setActiveFormat] = useState<BlobFormat | undefined>(undefined);
  const [slicedOnly, setSlicedOnly] = useState(false);
  const [sort, setSort] = useState<string>("-updated_at");

  const tagsQuery = useTags();

  const filters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      tag: activeTag,
      format: activeFormat,
      has_sliced: slicedOnly || undefined,
      sort,
    }),
    [debouncedSearch, activeTag, activeFormat, slicedOnly, sort],
  );

  const modelsQuery = useModelsQuery(filters);
  const items = modelsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && modelsQuery.hasNextPage && !modelsQuery.isFetchingNextPage) {
        void modelsQuery.fetchNextPage();
      }
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [modelsQuery]);

  const isEmpty = !modelsQuery.isLoading && items.length === 0;

  return (
    <div className="flex gap-6">
      <aside className="w-56 shrink-0 space-y-6">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Tags</h2>
          <div className="flex flex-wrap gap-1.5">
            {(tagsQuery.data ?? []).map((tag) => (
              <button key={tag.id} type="button" onClick={() => setActiveTag(activeTag === tag.name ? undefined : tag.name)}>
                <Badge variant={activeTag === tag.name ? "default" : "outline"}>{tag.name}</Badge>
              </button>
            ))}
            {tagsQuery.data?.length === 0 && <p className="text-xs text-muted-foreground">No tags yet</p>}
          </div>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Formats</h2>
          <RadioGroup
            value={activeFormat ?? "all"}
            onValueChange={(value) => setActiveFormat(value === "all" ? undefined : (value as BlobFormat))}
          >
            <Label className="flex items-center gap-2 text-sm font-normal">
              <RadioGroupItem value="all" />
              All
            </Label>
            {BLOB_FORMATS.map((format) => (
              <Label key={format} className="flex items-center gap-2 text-sm font-normal">
                <RadioGroupItem value={format} />
                {FORMAT_LABELS[format]}
              </Label>
            ))}
          </RadioGroup>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Sliced</h2>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox
              checked={slicedOnly}
              onCheckedChange={(checked) => setSlicedOnly(checked === true)}
            />
            Sliced only
          </Label>
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search models…"
              className="pl-8"
              aria-label="Search models"
            />
          </div>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <NewModelDialog
            trigger={
              <Button type="button">
                <PlusIcon /> New model
              </Button>
            }
          />
        </div>

        {modelsQuery.isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, index) => (
              <Skeleton key={index} className="aspect-[3/4] w-full rounded-xl" />
            ))}
          </div>
        ) : modelsQuery.isError ? (
          <Card className="mx-auto mt-12 max-w-md">
            <CardHeader className="items-center text-center">
              <CardTitle>Couldn&apos;t load models</CardTitle>
              <CardDescription>
                {modelsQuery.error instanceof ApiError
                  ? modelsQuery.error.detail
                  : "Something went wrong loading the gallery."}
              </CardDescription>
            </CardHeader>
            <div className="flex justify-center pb-4">
              <Button type="button" onClick={() => void modelsQuery.refetch()}>
                Retry
              </Button>
            </div>
          </Card>
        ) : isEmpty ? (
          <Card className="mx-auto mt-12 max-w-md">
            <CardHeader className="items-center text-center">
              <CardTitle>No models yet</CardTitle>
              <CardDescription>Upload your first 3D model to get started.</CardDescription>
            </CardHeader>
            <div className="flex justify-center pb-4">
              <Button asChild>
                <Link to="/upload">Upload a model</Link>
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {items.map((model) => (
                <ModelCard key={model.id} model={model} />
              ))}
            </div>
            <div ref={sentinelRef} className="h-1" />
            {modelsQuery.isFetchingNextPage && (
              <p className="py-4 text-center text-sm text-muted-foreground">Loading more…</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
