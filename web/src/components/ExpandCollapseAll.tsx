import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Expand-all/collapse-all icon-button pair for a card header sitting above a
 * list of collapsible sections (paired with `useOpenMap`). Icon-only -- this
 * lives in tight card headers rather than the roomier toolbar the
 * ViewerStage "All"/"None" text buttons occupy -- so the icons carry the
 * meaning and `aria-label`/`title` carry the accessible name and tooltip. */
export function ExpandCollapseAll({
  allOpen,
  allClosed,
  onExpandAll,
  onCollapseAll,
  label,
}: {
  allOpen: boolean;
  allClosed: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  /** Plural noun describing what's being expanded/collapsed, e.g. "review
   * groups" -- used in the aria-labels and title tooltips. */
  label: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={`Expand all ${label}`}
        title={`Expand all ${label}`}
        disabled={allOpen}
        onClick={onExpandAll}
      >
        <ChevronsUpDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={`Collapse all ${label}`}
        title={`Collapse all ${label}`}
        disabled={allClosed}
        onClick={onCollapseAll}
      >
        <ChevronsDownUpIcon />
      </Button>
    </div>
  );
}
