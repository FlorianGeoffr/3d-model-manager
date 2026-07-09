import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PlusIcon, SearchIcon, TagIcon } from "lucide-react";

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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/lib/format";
import { BLOB_FORMATS, type BlobFormat } from "@/api/types";
import { FORMAT_LABELS } from "@/lib/formatMeta";

const SORT_OPTIONS = [
  { value: "-updated_at", label: "Recently updated" },
  { value: "name", label: "Name" },
] as const;

/** A single-select filter chip (used for the format facet). Rendered as a
 * button wrapping a Badge so it keeps an accessible name + `aria-pressed`. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className="rounded-4xl">
      <Badge variant={active ? "default" : "outline"} className="cursor-pointer">
        {children}
      </Badge>
    </button>
  );
}

export function LibraryPage() {
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [activeTag, setActiveTag] = useState<string | undefined>(undefined);
  // The backend's `format` filter accepts a single value (SPEC "API surface"),
  // so the chips behave as a single-select facet ("All" clears it).
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
  const tags = tagsQuery.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3">
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by format">
            <FilterChip active={!activeFormat} onClick={() => setActiveFormat(undefined)}>
              All
            </FilterChip>
            {BLOB_FORMATS.map((format) => (
              <FilterChip
                key={format}
                active={activeFormat === format}
                onClick={() => setActiveFormat(activeFormat === format ? undefined : format)}
              >
                {FORMAT_LABELS[format]}
              </FilterChip>
            ))}
          </div>

          <div className="hidden h-5 w-px bg-border sm:block" />

          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox
              checked={slicedOnly}
              onCheckedChange={(checked) => setSlicedOnly(checked === true)}
            />
            Sliced only
          </Label>

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <TagIcon /> {activeTag ? `Tag: ${activeTag}` : "Tags"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setActiveTag(activeTag === tag.name ? undefined : tag.name)}
                  >
                    <Badge variant={activeTag === tag.name ? "default" : "outline"} className="cursor-pointer">
                      {tag.name}
                    </Badge>
                  </button>
                ))}
                {tags.length === 0 && <p className="text-xs text-muted-foreground">No tags yet</p>}
              </div>
            </PopoverContent>
          </Popover>
        </div>
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
              <Link to="/add">Add a model</Link>
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
  );
}
