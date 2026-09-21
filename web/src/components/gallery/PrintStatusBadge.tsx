import { useState } from "react";
import { CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import type { PrintStatus } from "@/api/types";
import { ALL_PRINT_STATUSES, getPrintStatusMeta } from "@/lib/printStatus";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function PrintStatusBadge({
  status,
  quantityTarget = 1,
  quantityPrinted = 0,
  onChangeStatus,
  onChangeQuantity,
  interactive = true,
  showQuantity = true,
  className,
}: {
  status?: PrintStatus | string | null;
  quantityTarget?: number;
  quantityPrinted?: number;
  onChangeStatus?: (nextStatus: PrintStatus) => void;
  onChangeQuantity?: (printed: number, target: number) => void;
  interactive?: boolean;
  showQuantity?: boolean;
  className?: string;
}) {
  const meta = getPrintStatusMeta(status);
  const [menuOpen, setMenuOpen] = useState(false);

  function handleIncrement(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!onChangeQuantity) return;
    const nextPrinted = quantityPrinted + 1;
    onChangeQuantity(nextPrinted, quantityTarget);
    if (nextPrinted >= quantityTarget && onChangeStatus && status !== "printed") {
      onChangeStatus("printed");
    }
  }

  function handleDecrement(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!onChangeQuantity || quantityPrinted <= 0) return;
    const nextPrinted = Math.max(0, quantityPrinted - 1);
    onChangeQuantity(nextPrinted, quantityTarget);
  }

  const isCompleted = quantityPrinted >= quantityTarget && quantityTarget > 0;

  const badgeContent = (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal transition-colors text-xs select-none",
        meta.badgeClass,
        interactive && onChangeStatus && "cursor-pointer hover:opacity-80",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full shrink-0", meta.dotClass)} />
      <span>{meta.label}</span>
      {showQuantity && (
        <span
          className={cn(
            "ml-1 tabular-mono font-medium px-1 py-0.2 rounded text-[11px]",
            isCompleted
              ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
              : "bg-background/60 text-foreground/80",
          )}
          title={`Imprimé ${quantityPrinted} sur ${quantityTarget}`}
        >
          {quantityPrinted}/{quantityTarget}
        </span>
      )}
    </Badge>
  );

  if (!interactive || !onChangeStatus) {
    return badgeContent;
  }

  return (
    <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>{badgeContent}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {ALL_PRINT_STATUSES.map((st) => {
            const itemMeta = getPrintStatusMeta(st);
            const isSelected = st === status || (!status && st === "idle");
            return (
              <DropdownMenuItem
                key={st}
                onClick={() => onChangeStatus(st)}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={cn("size-2 rounded-full", itemMeta.dotClass)} />
                  {itemMeta.label}
                </span>
                {isSelected && <CheckIcon className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {showQuantity && onChangeQuantity && (
        <div className="inline-flex items-center rounded-md border border-border bg-background/80 shadow-xs">
          <button
            type="button"
            disabled={quantityPrinted <= 0}
            onClick={handleDecrement}
            aria-label="Diminuer quantité imprimée"
            className="p-1 hover:bg-muted rounded-l disabled:opacity-30 transition-colors"
          >
            <MinusIcon className="size-3" />
          </button>
          <button
            type="button"
            onClick={handleIncrement}
            aria-label="Augmenter quantité imprimée"
            className="p-1 hover:bg-muted rounded-r transition-colors"
          >
            <PlusIcon className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}
