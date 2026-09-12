import { Boxes, RotateCcwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FilamentChip } from "@/components/ui/filament-chip";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FORMAT_LABELS } from "@/lib/formatMeta";
import type { PartColors } from "@/components/viewer/partColors";
import type { FileOut } from "@/api/types";

/** What the rail's selection points at -- the synthetic combined-assembly
 * entry, or one non-combinable file (sliced/gcode/pending/failed/
 * unsupported). Shared with `StudioWorkspace`/`StudioSurface` so all three
 * agree on the shape without a circular import. */
export type StudioSelection = { type: "assembly" } | { type: "file"; id: number };

export function isSameSelection(a: StudioSelection | undefined, b: StudioSelection): boolean {
  if (!a) return false;
  if (a.type === "assembly") return b.type === "assembly";
  return b.type === "file" && a.id === b.id;
}

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

/** Left-hand file rail for the model-detail studio (Phase 4): one entry per
 * viewable file, plus a synthetic "Assembly (N parts)" entry at top when the
 * model has any ready-GLB parts to combine. Selecting the assembly entry
 * expands it into a checklist of its parts with visibility checkboxes AND a
 * per-part color swatch -- `ViewerTab`'s old `MeshSection` per-part toggle
 * and recolor, moved here so this is the SINGLE source of truth for part
 * visibility/color; `ViewerStage`'s own Parts checklist is hidden
 * (`showPartsList={false}`) when rendered inside the studio to avoid a
 * second, redundant control bound to the same state. */
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
      <nav aria-label="Files" className="flex w-56 shrink-0 flex-col gap-1">
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
