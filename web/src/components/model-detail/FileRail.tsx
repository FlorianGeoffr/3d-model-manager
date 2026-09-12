import { Boxes } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { FORMAT_LABELS } from "@/lib/formatMeta";
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
 * expands it into a checklist of its parts with visibility checkboxes --
 * `ViewerTab`'s old `MeshSection` per-part toggle, moved here so switching
 * which part is visible doesn't require opening the (also still present)
 * parts panel inside `ViewerStage`. */
export function FileRail({
  glbFiles,
  otherFiles,
  selection,
  onSelect,
  checkedIds,
  onToggleFile,
}: {
  glbFiles: FileOut[];
  otherFiles: FileOut[];
  selection: StudioSelection | undefined;
  onSelect: (selection: StudioSelection) => void;
  checkedIds: ReadonlySet<number>;
  onToggleFile: (fileId: number, checked: boolean) => void;
}) {
  const assemblySelected = isSameSelection(selection, { type: "assembly" });

  return (
    <nav aria-label="Files" className="flex w-56 shrink-0 flex-col gap-1">
      {glbFiles.length > 0 && (
        <div className="space-y-1">
          <RailRow selected={assemblySelected} onClick={() => onSelect({ type: "assembly" })}>
            <Boxes className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Assembly ({glbFiles.length} parts)</span>
          </RailRow>
          {assemblySelected && (
            <div className="space-y-1 pl-2">
              {glbFiles.map((file) => (
                <label
                  key={file.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                >
                  <Checkbox
                    checked={checkedIds.has(file.id)}
                    onCheckedChange={(next) => onToggleFile(file.id, next === true)}
                    aria-label={file.rel_path}
                  />
                  <span className="min-w-0 flex-1 truncate" title={file.rel_path}>
                    {file.rel_path}
                  </span>
                </label>
              ))}
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
  );
}
