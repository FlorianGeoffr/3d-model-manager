import { Boxes, RotateCcwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FilamentChip } from "@/components/ui/filament-chip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import type { PartColors } from "@/components/viewer/partColors";
import { isSameSelection, type StudioSelection } from "@/components/model-detail/studioSelection";
import type { FileOut } from "@/api/types";

/** Status chip for one rail entry -- mirrors the state cards `StudioSurface`
 * renders for the selected file (pending/failed/unsupported/sliced/gcode),
 * so the rail previews what selecting an entry will show. */
function StatusChip({ file }: { file: FileOut }) {
  if (file.kind === "sliced") return <Badge variant="secondary">Sliced</Badge>;
  if (file.format === "gcode") return <Badge variant="secondary">G-code</Badge>;
  switch (file.glb_status) {
    case "pending":
      return <Badge variant="secondary">Pending</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "unsupported":
      return <Badge variant="outline">No preview</Badge>;
    default:
      return null;
  }
}

/** One part's visibility checkbox + color swatch + reset button -- the exact
 * row markup the old `ViewerStage` right panel's Parts checklist used
 * (aria-labels unchanged: `file.rel_path`, `Color for ${file.rel_path}`,
 * `Reset color for ${file.rel_path}`), extracted so `ViewerTopOverlay`'s
 * Parts popover (R13a re-chrome) renders the SAME rows instead of a second,
 * slightly-different copy. */
export function PartRow({
  file,
  checked,
  color,
  onToggle,
  onSetColor,
  onClearColor,
}: {
  file: FileOut;
  checked: boolean;
  color: string | undefined;
  onToggle: (checked: boolean) => void;
  onSetColor: (hex: string) => void;
  onClearColor: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-2", !checked && "opacity-60")}>
      <Checkbox checked={checked} onCheckedChange={(next) => onToggle(next === true)} aria-label={file.rel_path} />
      <label className="relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring/50">
        <FilamentChip color={color ?? "#cccccc"} />
        <input
          type="color"
          aria-label={`Color for ${file.rel_path}`}
          value={color ?? "#cccccc"}
          onChange={(event) => onSetColor(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      <span className="min-w-0 flex-1 truncate text-sm" title={file.rel_path}>
        {file.rel_path}
      </span>
      {color && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Reset color for ${file.rel_path}`}
              onClick={onClearColor}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <RotateCcwIcon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Reset color</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface PartRowListProps {
  glbFiles: FileOut[];
  checkedIds: ReadonlySet<number>;
  onToggleFile: (fileId: number, checked: boolean) => void;
  colors: PartColors;
  onSetPartColor: (fileId: number, hex: string) => void;
  onClearPartColor: (fileId: number) => void;
}

/** One `PartRow` per part, no header -- shared by `FileRail`'s inline
 * assembly expansion (which has its own All/None row already, see below)
 * and `PartsChecklist` below. */
export function PartRowList({
  glbFiles,
  checkedIds,
  onToggleFile,
  colors,
  onSetPartColor,
  onClearPartColor,
}: PartRowListProps) {
  return (
    <div className="space-y-1">
      {glbFiles.map((file) => (
        <PartRow
          key={file.id}
          file={file}
          checked={checkedIds.has(file.id)}
          color={colors[file.id]}
          onToggle={(checked) => onToggleFile(file.id, checked)}
          onSetColor={(hex) => onSetPartColor(file.id, hex)}
          onClearColor={() => onClearPartColor(file.id)}
        />
      ))}
    </div>
  );
}

/** Count + All/None header (same aria-labels as the old `ViewerStage` right
 * panel: "Show all parts", "None — hide all parts") followed by
 * `PartRowList` -- the whole Parts checklist block used standalone by
 * `ViewerTopOverlay`'s Parts popover (R13a re-chrome). */
export function PartsChecklist({
  glbFiles,
  checkedIds,
  onToggleFile,
  onSetAllChecked,
  colors,
  onSetPartColor,
  onClearPartColor,
}: PartRowListProps & { onSetAllChecked: (checked: boolean) => void }) {
  const checkedCount = glbFiles.filter((file) => checkedIds.has(file.id)).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {checkedCount} of {glbFiles.length}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Show all parts"
            disabled={checkedCount === glbFiles.length}
            onClick={() => onSetAllChecked(true)}
          >
            All
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="None — hide all parts"
            disabled={checkedCount === 0}
            onClick={() => onSetAllChecked(false)}
          >
            None
          </Button>
        </div>
      </div>
      <PartRowList
        glbFiles={glbFiles}
        checkedIds={checkedIds}
        onToggleFile={onToggleFile}
        colors={colors}
        onSetPartColor={onSetPartColor}
        onClearPartColor={onClearPartColor}
      />
    </div>
  );
}

function RailRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected ? "bg-secondary text-secondary-foreground" : "hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

/** File rail for the model-detail studio (Phase 4): one entry per viewable
 * file, plus a synthetic "Assembly (N parts)" entry at top when the model
 * has any ready-GLB parts to combine. Selecting the assembly entry expands
 * it into a checklist of its parts with visibility checkboxes AND a
 * per-part color swatch.
 *
 * R13a re-chrome: `StudioWorkspace` no longer renders this as a left column
 * -- the Parts checklist now lives in `ViewerTopOverlay`'s popover, built
 * from this file's `PartsChecklist`/`PartRow` exports instead. This
 * component (and its own "Assembly" vs. other-file selector) stays for its
 * own test coverage and as the basis those exports were extracted from;
 * wiring it back into the studio as a "browse other files" surface is
 * R13c's Files-card work. */
export function FileRail({
  glbFiles,
  otherFiles,
  selection,
  onSelect,
  checkedIds,
  onToggleFile,
  onSetAllChecked,
  colors,
  onSetPartColor,
  onClearPartColor,
}: {
  glbFiles: FileOut[];
  otherFiles: FileOut[];
  selection: StudioSelection | undefined;
  onSelect: (selection: StudioSelection) => void;
  checkedIds: ReadonlySet<number>;
  onToggleFile: (fileId: number, checked: boolean) => void;
  onSetAllChecked: (checked: boolean) => void;
  colors: PartColors;
  onSetPartColor: (fileId: number, hex: string) => void;
  onClearPartColor: (fileId: number) => void;
}) {
  const assemblySelected = isSameSelection(selection, { type: "assembly" });
  const checkedCount = glbFiles.filter((file) => checkedIds.has(file.id)).length;

  return (
    <TooltipProvider>
      <nav aria-label="Files" className="flex w-full min-w-0 flex-col gap-1 md:w-56 md:shrink-0">
      {glbFiles.length > 0 && (
        <div className="space-y-1">
          <div
            className={cn(
              "flex items-center gap-1 rounded-md pr-1",
              assemblySelected && "bg-secondary text-secondary-foreground",
            )}
          >
            <button
              type="button"
              aria-pressed={assemblySelected}
              onClick={() => onSelect({ type: "assembly" })}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 hover:bg-muted"
            >
              <Boxes className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Assembly ({glbFiles.length} parts)</span>
            </button>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {checkedCount} of {glbFiles.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Show all parts"
              disabled={checkedCount === glbFiles.length}
              onClick={() => onSetAllChecked(true)}
            >
              All
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="None — hide all parts"
              disabled={checkedCount === 0}
              onClick={() => onSetAllChecked(false)}
            >
              None
            </Button>
          </div>
          {assemblySelected && (
            <div className="space-y-1 pl-2">
              {glbFiles.map((file) => {
                const partColor = colors[file.id];
                return (
                  <div
                    key={file.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    <Checkbox
                      checked={checkedIds.has(file.id)}
                      onCheckedChange={(next) => onToggleFile(file.id, next === true)}
                      aria-label={file.rel_path}
                    />
                    <label className="relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full focus-within:ring-2 focus-within:ring-ring/50">
                      <FilamentChip color={partColor ?? "#cccccc"} />
                      <input
                        type="color"
                        aria-label={`Color for ${file.rel_path}`}
                        value={partColor ?? "#cccccc"}
                        onChange={(event) => onSetPartColor(file.id, event.target.value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      />
                    </label>
                    <span className="min-w-0 flex-1 truncate" title={file.rel_path}>
                      {file.rel_path}
                    </span>
                    {partColor && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Reset color for ${file.rel_path}`}
                            onClick={() => onClearPartColor(file.id)}
                            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                          >
                            <RotateCcwIcon className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>Reset color</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {otherFiles.map((file) => {
        const rowSelection: StudioSelection = { type: "file", id: file.id };
        return (
          <RailRow
            key={file.id}
            selected={isSameSelection(selection, rowSelection)}
            onClick={() => onSelect(rowSelection)}
          >
            <span className="min-w-0 flex-1 truncate" title={file.rel_path}>
              {file.rel_path}
            </span>
            <Badge variant="outline">{FORMAT_LABELS[file.format]}</Badge>
            <StatusChip file={file} />
          </RailRow>
        );
      })}
      </nav>
    </TooltipProvider>
  );
}
