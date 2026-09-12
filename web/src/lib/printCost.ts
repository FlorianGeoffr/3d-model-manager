/**
 * Print cost estimate (R11-B item 14): `filament_g`/`duration_s` off a
 * print/plate, multiplied against the operator's own
 * `filament_cost_per_kg`/`machine_cost_per_hour` rates (`AppSettings`,
 * `GET/PUT /settings/app`). Currency-agnostic -- callers format with 2
 * decimals and no currency symbol (a `currency_symbol` setting is out of
 * scope for this task).
 */
import type { AppSettings } from "@/api/types";

export interface PrintCostInput {
  filament_g: number | null | undefined;
  duration_s: number | null | undefined;
}

/** `null` when neither `filament_g` nor `duration_s` is known -- there's
 * nothing to estimate from. A single known field still produces a partial
 * estimate (e.g. filament cost with no duration on hand). */
export function estimatePrintCost(
  input: PrintCostInput,
  settings: Pick<AppSettings, "filament_cost_per_kg" | "machine_cost_per_hour">,
): number | null {
  const hasFilament = input.filament_g !== null && input.filament_g !== undefined;
  const hasDuration = input.duration_s !== null && input.duration_s !== undefined;
  if (!hasFilament && !hasDuration) return null;

  const filamentCost = hasFilament
    ? ((input.filament_g as number) / 1000) * settings.filament_cost_per_kg
    : 0;
  const machineCost = hasDuration
    ? ((input.duration_s as number) / 3600) * settings.machine_cost_per_hour
    : 0;

  return filamentCost + machineCost;
}

/** 2 decimals, no currency symbol (matches the brief's formatting rule). */
export function formatPrintCost(cost: number): string {
  return cost.toFixed(2);
}
