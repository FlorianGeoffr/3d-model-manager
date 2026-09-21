import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { FileStackIcon, StarIcon } from "lucide-react";

import { modelQueryOptions, usePatchModel, useTagColorMap } from "@/api/library";
import { PrintStatusBadge } from "@/components/gallery/PrintStatusBadge";
import { OpenInSlicerButton } from "@/components/model-detail/OpenInSlicerButton";
import { SendToPrinterButton } from "@/components/model-detail/SendToPrinterButton";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatIcon } from "@/lib/formatMeta";
import { formatDate } from "@/lib/format";
import { tagColorClass } from "@/lib/tagColors";
import { LIST_ROW_HEIGHT_PX } from "@/lib/grid";
import { cn } from "@/lib/utils";
import type { ModelSummary } from "@/api/types";

const VISIBLE_TAGS = 2;

/** List-view row (R13b): a horizontal, fixed-height (`LIST_ROW_HEIGHT_PX`)
 * alternative to `ModelCard`'s grid tile -- same selection/quick-action
 * affordances, laid out as a single line instead of a card. Meant to be
 * virtualized one-per-row (unlike the grid's `chunkIntoRows` fan-out), so its
 * own height must always match `LIST_ROW_HEIGHT_PX` exactly. */
export function ModelRow({
  model,
  index,
  selected = false,
  selectedIds,
  selectMode = false,
  onSelectChange,
  onModifiedClick,
  onMergeModels,
}: {
  model: ModelSummary;
  /** Position in the gallery's flat item list -- ctrl/cmd/shift+click range
   * selection, same contract as `ModelCard`. */
  index?: number;
  selected?: boolean;
  /** All currently selected IDs for dragging multi-selection */
  selectedIds?: Set<number>;
  /** Explicit selection mode active */
  selectMode?: boolean;
  onSelectChange?: (id: number, next: boolean) => void;
  /** Ctrl/Cmd/Shift+click range/toggle select (R9-A item 6): fired instead
   * of navigating when the card's `<Link>` is clicked with a modifier held. */
  onModifiedClick?: (event: React.MouseEvent, index: number) => void;
  /** Callback fired when other model cards/rows are dropped on this row to merge */
  onMergeModels?: (target: ModelSummary, sourceIds: number[]) => void;
}) {
  const [coverErrored, setCoverErrored] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDragOverRow, setIsDragOverRow] = useState(false);
  const patchModel = usePatchModel(model.slug);
  const queryClient = useQueryClient();
  const tagColors = useTagColorMap();

  function onIntent() {
    void queryClient.prefetchQuery({ ...modelQueryOptions(model.slug), staleTime: 30_000 });
  }

  const visibleTags = model.tags.slice(0, VISIBLE_TAGS);
  const overflowCount = model.tags.length - visibleTags.length;
  const uniqueFormats = Array.from(new Set(model.formats));
  const primaryFormat = model.formats[0];
  const Icon = formatIcon(primaryFormat);
  const showCover = model.cover !== null && !coverErrored;
  const hasQuickActions = model.best_slicer_file !== null || model.printable_file !== null;

  function stopRowNavigation(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  function onLinkClick(event: React.MouseEvent) {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onModifiedClick?.(event, index ?? 0);
      return;
    }
    if ((selectedIds && selectedIds.size > 0) || selectMode) {
      event.preventDefault();
      if (onModifiedClick) {
        onModifiedClick(event, index ?? 0);
      } else {
        onSelectChange?.(model.id, !selected);
      }
    }
  }

  function handleDragStart(e: React.DragEvent) {
    const ids =
      selected && selectedIds && selectedIds.size > 0
        ? Array.from(selectedIds)
        : [model.id];
    const payload = JSON.stringify({ ids, sourceModelId: model.id, sourceSlug: model.slug });
    e.dataTransfer.setData("application/json", payload);
    e.dataTransfer.setData("text/plain", payload);
    e.dataTransfer.effectAllowed = "move";
    setIsDragging(true);
  }

  function handleDragEnd() {
    setIsDragging(false);
  }

  function handleRowDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes("application/json")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setIsDragOverRow(true);
    }
  }

  function handleRowDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOverRow(false);
    }
  }

  function handleRowDrop(e: React.DragEvent) {
    setIsDragOverRow(false);
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      let ids: number[] = [];
      if (Array.isArray(data.ids)) ids = data.ids;
      else if (data.sourceModelId) ids = [data.sourceModelId];

      const otherIds = ids.filter((id) => id !== model.id);
      if (otherIds.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        onMergeModels?.(model, otherIds);
      }
    } catch {}
  }

  return (
    <Link
      to="/models/$slug"
      params={{ slug: model.slug }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleRowDragOver}
      onDragLeave={handleRowDragLeave}
      onDrop={handleRowDrop}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg border border-transparent px-2 hover:border-border hover:bg-muted/50 transition-all",
        isDragging && "opacity-40",
        selected && "ring-2 ring-primary border-primary bg-primary/5",
        isDragOverRow && "ring-2 ring-primary border-primary bg-primary/15",
      )}
      style={{ height: LIST_ROW_HEIGHT_PX }}
      preload="intent"
      onClick={onLinkClick}
      onPointerEnter={onIntent}
      onFocus={onIntent}
    >
      <span
        className="contents"
        onClick={(e) => {
          stopRowNavigation(e);
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            onModifiedClick?.(e, index ?? 0);
          } else {
            onSelectChange?.(model.id, !selected);
            if (onModifiedClick) onModifiedClick(e, index ?? 0);
          }
        }}
      >
        <Checkbox
          checked={selected}
          aria-label={`Select ${model.name}`}
          className={cn(
            "shrink-0 transition-opacity",
            selected || selectMode
              ? "opacity-100 ring-2 ring-primary/40"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        />
      </span>

      <div className="relative size-24 shrink-0 overflow-hidden rounded-md bg-muted">
        {showCover ? (
          <img
            src={model.cover ?? undefined}
            alt={model.name}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            draggable={false}
            className="size-full object-cover pointer-events-none"
            onError={() => setCoverErrored(true)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground" data-testid="format-thumb">
            <Icon className="size-6" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium" title={model.name}>
            {model.name}
          </h3>
          {model.project && (
            <Badge variant="outline" className="shrink-0 gap-1" data-testid="project-badge">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", tagColorClass(model.project.color) ?? "bg-muted-foreground")}
              />
              {model.project.name}
            </Badge>
          )}
          {model.category && (
            <Badge variant="outline" className="shrink-0 gap-1">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", tagColorClass(model.category.color) ?? "bg-muted-foreground")}
              />
              {model.category.name}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleTags.map((tag) => (
            <Badge key={tag} variant="secondary" className={tagColorClass(tagColors[tag])}>
              {tag}
            </Badge>
          ))}
          {overflowCount > 0 && <Badge variant="outline">+{overflowCount}</Badge>}
          {uniqueFormats.map((format) => (
            <Badge key={format} variant="outline">
              {format}
            </Badge>
          ))}
        </div>
      </div>

      <span className="contents" onClick={stopRowNavigation}>
        <PrintStatusBadge
          status={model.print_status}
          quantityTarget={model.quantity_target}
          quantityPrinted={model.quantity_printed}
          onChangeStatus={(nextStatus) => patchModel.mutate({ print_status: nextStatus })}
          onChangeQuantity={(printed, target) =>
            patchModel.mutate({ quantity_printed: printed, quantity_target: target })
          }
        />
      </span>

      <div className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex" data-testid="model-row-meta">
        <FileStackIcon className="size-3" />
        {model.file_count} {model.file_count === 1 ? "file" : "files"}
      </div>

      <p className="hidden shrink-0 font-mono text-xs text-muted-foreground md:block">
        Updated {formatDate(model.updated_at)}
      </p>

      <span className="contents" onClick={stopRowNavigation}>
        <button
          type="button"
          aria-label={model.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={model.favorite}
          onClick={() => patchModel.mutate({ favorite: !model.favorite })}
          className="shrink-0 rounded-full p-1 text-foreground transition-colors hover:text-amber-500"
        >
          <StarIcon className={model.favorite ? "size-4 fill-amber-400 text-amber-500" : "size-4"} />
        </button>
      </span>

      {hasQuickActions && (
        <span className="contents" onClick={stopRowNavigation}>
          <div className="flex shrink-0 items-center gap-1">
            {model.best_slicer_file && <OpenInSlicerButton file={model.best_slicer_file} size="icon-sm" />}
            {model.printable_file && <SendToPrinterButton file={model.printable_file} />}
          </div>
        </span>
      )}
    </Link>
  );
}
