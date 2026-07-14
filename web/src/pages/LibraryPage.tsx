import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  BookmarkIcon,
  ListPlusIcon,
  PlusIcon,
  SearchIcon,
  SquareCheckIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { useFollowedCollections } from "@/api/collections";
import { useBulkDeleteModels, useBulkUpdateModels, useModelsQuery, useTags } from "@/api/library";
import { useEnqueueModel } from "@/api/queue";
import { ApiError } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { BLOB_FORMATS, type BlobFormat, type ModelSummary } from "@/api/types";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import type { LibrarySearch } from "@/pages/librarySearch";

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
  // One-way seed only: a provenance badge or a related-models card can deep
  // link here with `?collection=<id>` (see `librarySearch.ts`), but the
  // facet's own selections never write back to the URL -- same as every
  // other filter on this page.
  const search = useSearch({ strict: false }) as LibrarySearch;

  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [activeTag, setActiveTag] = useState<string | undefined>(undefined);
  // The backend's `format` filter accepts a single value (SPEC "API surface"),
  // so the chips behave as a single-select facet ("All" clears it).
  const [activeFormat, setActiveFormat] = useState<BlobFormat | undefined>(undefined);
  const [slicedOnly, setSlicedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [activeCollection, setActiveCollection] = useState<number | undefined>(search.collection);
  const [sort, setSort] = useState<string>("-updated_at");

  // Bulk select mode: per-visit UI state only, same as the facets above --
  // never persisted, never written to the URL.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: number, next: boolean) {
    setSelectedIds((prev) => {
      const updated = new Set(prev);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
  }

  const tagsQuery = useTags();
  const collectionsQuery = useFollowedCollections();
  const collections = collectionsQuery.data ?? [];
  const activeCollectionTitle = collections.find((collection) => collection.id === activeCollection)?.title;

  const filters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      tag: activeTag,
      format: activeFormat,
      has_sliced: slicedOnly || undefined,
      collection: activeCollection,
      favorite: favoritesOnly || undefined,
      archived: archivedOnly || undefined,
      sort,
    }),
    [debouncedSearch, activeTag, activeFormat, slicedOnly, favoritesOnly, archivedOnly, activeCollection, sort],
  );

  const modelsQuery = useModelsQuery(filters);
  const items = modelsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedItems = items.filter((model) => selectedIds.has(model.id));

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
          <Button
            type="button"
            variant={selectMode ? "default" : "outline"}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            <SquareCheckIcon /> Select
          </Button>
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

          <FilterChip active={favoritesOnly} onClick={() => setFavoritesOnly((prev) => !prev)}>
            <StarIcon className={favoritesOnly ? "fill-current" : undefined} />
            Favorites
          </FilterChip>

          <FilterChip active={archivedOnly} onClick={() => setArchivedOnly((prev) => !prev)}>
            <ArchiveIcon />
            Include archived
          </FilterChip>

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

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <BookmarkIcon /> {activeCollectionTitle ? `Collection: ${activeCollectionTitle}` : "Collection"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <div className="flex flex-wrap gap-1.5">
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    onClick={() =>
                      setActiveCollection(activeCollection === collection.id ? undefined : collection.id)
                    }
                  >
                    <Badge
                      variant={activeCollection === collection.id ? "default" : "outline"}
                      className="cursor-pointer"
                    >
                      {`${collection.title} (${collection.site})`}
                    </Badge>
                  </button>
                ))}
                {collections.length === 0 && (
                  <p className="text-xs text-muted-foreground">No followed collections</p>
                )}
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
              <ModelCard
                key={model.id}
                model={model}
                selectable={selectMode}
                selected={selectedIds.has(model.id)}
                onSelectChange={toggleSelected}
              />
            ))}
          </div>
          <div ref={sentinelRef} className="h-1" />
          {modelsQuery.isFetchingNextPage && (
            <p className="py-4 text-center text-sm text-muted-foreground">Loading more…</p>
          )}
        </>
      )}

      {selectMode && selectedItems.length > 0 && (
        <SelectionActionBar selectedItems={selectedItems} onDone={exitSelectMode} />
      )}
    </div>
  );
}

/** Floating bulk-action bar (fixed bottom-center) shown once at least one
 * model is checked in select mode. Tag add/remove and favorite go through
 * `useBulkUpdateModels` (`POST /models/bulk`); queueing has no bulk endpoint,
 * so it loops `useEnqueueModel` over the selection instead. Delete goes
 * through `useBulkDeleteModels` (`POST /models/bulk-delete`, Round 11 T1). */
function SelectionActionBar({ selectedItems, onDone }: { selectedItems: ModelSummary[]; onDone: () => void }) {
  const [tagToAdd, setTagToAdd] = useState("");
  const [addTagOpen, setAddTagOpen] = useState(false);
  const [removeTagOpen, setRemoveTagOpen] = useState(false);
  const [queueing, setQueueing] = useState(false);

  const bulkUpdate = useBulkUpdateModels();
  const bulkDelete = useBulkDeleteModels();
  // `silentError`: this loops one enqueue mutation per selected model and
  // toasts a single summary below -- the global per-mutation error toast
  // would otherwise fire once per failed model on top of it.
  const enqueueModel = useEnqueueModel({ silentError: true });

  const ids = selectedItems.map((model) => model.id);
  const slugs = selectedItems.map((model) => model.slug);
  const tagsOnSelection = Array.from(new Set(selectedItems.flatMap((model) => model.tags))).sort();

  // The actions are mutually exclusive while any of them is in flight --
  // most importantly Delete vs the enqueue loop: models can otherwise be
  // hard-deleted out from under their own still-landing queue POSTs.
  const busy = bulkUpdate.isPending || bulkDelete.isPending || queueing;

  function addTag() {
    const trimmed = tagToAdd.trim();
    if (!trimmed || busy) return; // guards the Enter key, which no `disabled` covers
    bulkUpdate.mutate(
      { ids, add_tags: [trimmed] },
      {
        onSuccess: (result) => {
          toast.success(`Tagged ${result.updated} model${result.updated === 1 ? "" : "s"}`);
          setTagToAdd("");
          setAddTagOpen(false);
          onDone();
        },
      },
    );
  }

  function removeTag(name: string) {
    bulkUpdate.mutate(
      { ids, remove_tags: [name] },
      {
        onSuccess: (result) => {
          toast.success(`Untagged ${result.updated} model${result.updated === 1 ? "" : "s"}`);
          setRemoveTagOpen(false);
          onDone();
        },
      },
    );
  }

  function favoriteSelection() {
    bulkUpdate.mutate(
      { ids, favorite: true },
      {
        onSuccess: (result) => {
          toast.success(`Favorited ${result.updated} model${result.updated === 1 ? "" : "s"}`);
          // Non-destructive -- keep the selection live instead of exiting.
        },
      },
    );
  }

  async function addToQueue() {
    setQueueing(true);
    try {
      const results = await Promise.allSettled(ids.map((id) => enqueueModel.mutateAsync(id)));
      const succeeded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - succeeded;
      if (succeeded > 0) toast.success(`Added ${succeeded} model${succeeded === 1 ? "" : "s"} to queue`);
      // Fix-review F3: `Promise.allSettled` swallows rejections silently --
      // without this, a total failure (e.g. every model already queued)
      // left the user with no feedback at all.
      if (failed > 0) toast.error(`Failed to add ${failed} model${failed === 1 ? "" : "s"} to queue`);
    } finally {
      setQueueing(false);
    }
  }

  function deleteSelection() {
    // No local onError: queryClient.ts's global MutationCache.onError
    // already toasts the ApiError detail. The selection survives a failure
    // either way -- there's nothing to exit out of if the delete didn't
    // happen (or only partially happened; the hook's onSettled refetch
    // reconciles the gallery in that case).
    bulkDelete.mutate(
      { ids, slugs },
      {
        onSuccess: (result) => {
          toast.success(`Deleted ${result.deleted} model${result.deleted === 1 ? "" : "s"}`);
          onDone();
        },
      },
    );
  }

  return (
    <Card className="fixed inset-x-0 bottom-6 z-40 mx-auto w-fit flex-row items-center gap-3 px-4 py-2.5 shadow-lg">
      <span className="text-sm font-medium">
        {selectedItems.length} selected
      </span>

      <Popover open={addTagOpen} onOpenChange={setAddTagOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={busy}>
            <TagIcon /> Add tag
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-56">
          <Input
            autoFocus
            value={tagToAdd}
            placeholder="Tag name…"
            aria-label="Tag to add"
            onChange={(event) => setTagToAdd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addTag();
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            className="mt-2 w-full"
            disabled={!tagToAdd.trim() || busy}
            onClick={addTag}
          >
            Add
          </Button>
        </PopoverContent>
      </Popover>

      <Popover open={removeTagOpen} onOpenChange={setRemoveTagOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={busy}>
            <XIcon /> Remove tag
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-56">
          {tagsOnSelection.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {tagsOnSelection.map((name) => (
                <button key={name} type="button" disabled={busy} onClick={() => removeTag(name)}>
                  <Badge variant="outline" className="cursor-pointer">
                    {name}
                  </Badge>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">None of the selected models have tags.</p>
          )}
        </PopoverContent>
      </Popover>

      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={favoriteSelection}>
        <StarIcon /> Favorite
      </Button>

      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void addToQueue()}>
        <ListPlusIcon /> Add to queue
      </Button>

      <ConfirmDialog
        trigger={
          <Button type="button" variant="destructive" size="sm" disabled={busy}>
            <Trash2Icon /> Delete
          </Button>
        }
        title={`Delete ${ids.length} model${ids.length === 1 ? "" : "s"}?`}
        description="Permanently deletes the selected models and every file they store. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={deleteSelection}
      />

      <Button type="button" variant="ghost" size="sm" onClick={onDone}>
        Cancel
      </Button>
    </Card>
  );
}
