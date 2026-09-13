import { useState } from "react";
import { ChevronRightIcon, FolderIcon, SearchIcon } from "lucide-react";

import { useStorageTree } from "@/api/storageTree";
import { ApiError } from "@/api/client";
import { ModelCard } from "@/components/gallery/ModelCard";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/** Splits a `path` search param (`"figures/dnd/goblins"`) into its named
 * segments for the breadcrumb -- an empty/undefined path is the root, with
 * no segments at all. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function joinPath(segments: string[]): string {
  return segments.join("/");
}

/** Raw-storage folder navigation (R13b): one level of `GET /storage/tree` at
 * a time -- subfolders as cards, models directly in this folder as
 * `ModelCard`s. The current path is owned by the caller (`LibraryPage`'s
 * `?path=` search param) so switching view modes or navigating away/back
 * preserves it. */
export function FolderBrowser({
  path,
  onNavigate,
  selectedIds,
  onSelectChange,
  onModifiedClick,
}: {
  path: string;
  onNavigate: (path: string) => void;
  selectedIds: Set<number>;
  onSelectChange: (id: number, next: boolean) => void;
  onModifiedClick?: (event: React.MouseEvent, index: number) => void;
}) {
  const [filter, setFilter] = useState("");
  const treeQuery = useStorageTree(path);
  const segments = pathSegments(path);

  const dirs = treeQuery.data?.dirs ?? [];
  const models = treeQuery.data?.models ?? [];

  // No `useMemo` here: `dirs`/`models` are freshly derived (`?? []`) every
  // render anyway, so memoizing against them would never hit, and the
  // filtering itself is cheap (a folder's own dir/model list, not the whole
  // library).
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredDirs = dirs.filter((dir) => dir.name.toLowerCase().includes(normalizedFilter));
  const filteredModels = models.filter((model) => model.name.toLowerCase().includes(normalizedFilter));

  function goToRoot() {
    onNavigate("");
  }

  function goToSegment(index: number) {
    onNavigate(joinPath(segments.slice(0, index + 1)));
  }

  function openDir(name: string) {
    onNavigate(joinPath([...segments, name]));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={goToRoot}
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Library
          </button>
          {segments.map((segment, index) => (
            <span key={index} className="flex items-center gap-1">
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => goToSegment(index)}
                className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground aria-current:text-foreground aria-current:font-medium"
                aria-current={index === segments.length - 1 ? "page" : undefined}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>
        <div className="relative max-w-xs flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter this folder…"
            className="pl-8"
            aria-label="Filter this folder"
          />
        </div>
      </div>

      {treeQuery.isLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : treeQuery.isError ? (
        <Card className="mx-auto mt-12 max-w-md">
          <CardHeader className="items-center text-center">
            <CardTitle>Couldn&apos;t load this folder</CardTitle>
            <CardDescription>
              {treeQuery.error instanceof ApiError ? treeQuery.error.detail : "Something went wrong."}
            </CardDescription>
          </CardHeader>
          <div className="flex justify-center pb-4">
            <Button type="button" onClick={() => void treeQuery.refetch()}>
              Retry
            </Button>
          </div>
        </Card>
      ) : filteredDirs.length === 0 && filteredModels.length === 0 ? (
        <Card className="mx-auto mt-12 max-w-md">
          <CardHeader className="items-center text-center">
            <CardTitle>{filter.trim() ? "No matches" : "This folder is empty"}</CardTitle>
            <CardDescription>
              {filter.trim() ? "Try a different filter." : "No subfolders or models here."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {filteredDirs.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filteredDirs.map((dir) => (
                <button
                  key={dir.name}
                  type="button"
                  onClick={() => openDir(dir.name)}
                  className="flex items-center gap-2 rounded-xl border border-border bg-card p-3 text-left hover:bg-muted"
                >
                  <FolderIcon className="size-8 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{dir.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {dir.count} {dir.count === 1 ? "model" : "models"}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {filteredModels.length > 0 && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {filteredModels.map((model, index) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  index={index}
                  selected={selectedIds.has(model.id)}
                  onSelectChange={onSelectChange}
                  onModifiedClick={onModifiedClick}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
