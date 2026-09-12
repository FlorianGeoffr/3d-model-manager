import { Link } from "@tanstack/react-router";
import { Printer as PrinterIcon } from "lucide-react";

import { useFeatures } from "@/api/features";
import { usePrinterStatus, usePrinters } from "@/api/printers";
import { cn } from "@/lib/utils";

/** Compact live-status footer widget (R12): the first configured printer's
 * coarse state, reusing the same `usePrinters`/`usePrinterStatus` hooks as
 * `PrinterStatusPanel` so this never drifts from the real `/printer` page.
 * Hidden when the feature flag is off or nothing is configured yet --
 * there's nothing useful to show either way. */
export function SidebarPrinterWidget({ collapsed }: { collapsed: boolean }) {
  const features = useFeatures();
  const enabled = !!features.data?.printer_enabled;
  const printers = usePrinters({ enabled });
  const printer = printers.data?.[0];
  const status = usePrinterStatus(printer?.id ?? -1, { enabled: printer !== undefined });

  if (!enabled || !printer) return null;

  const s = status.data;
  const online = !!s?.online;
  const gs = s?.gcode_state ?? null;

  return (
    <Link
      to="/printer"
      className={cn(
        "mx-2 mb-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-2 text-xs hover:bg-muted",
        collapsed && "justify-center px-0",
      )}
      title={collapsed ? printer.name : undefined}
    >
      {collapsed ? (
        <PrinterIcon
          className={cn("size-4 shrink-0", online ? "text-primary" : "text-muted-foreground/50")}
        />
      ) : (
        <>
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              online ? (gs === "RUNNING" ? "bg-primary" : "bg-emerald-500") : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
            <span className="truncate text-foreground">{printer.name}</span>
            <span className="shrink-0 tabular-mono text-muted-foreground">
              {online ? (gs === "RUNNING" ? `${s.mc_percent ?? 0}%` : (gs ?? "online")) : "offline"}
            </span>
          </span>
        </>
      )}
    </Link>
  );
}
