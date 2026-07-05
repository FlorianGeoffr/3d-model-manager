/**
 * Small formatting helpers used instead of moment/lodash (Task 8
 * constraint: keep bundle sane — use `Intl` + small helpers).
 */
import { useEffect, useState } from "react";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Humanize a byte count, e.g. `1536` -> `"1.5 KB"`. */
export function humanizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value < 10 ? 1 : 0;
  return `${value.toFixed(precision)} ${SIZE_UNITS[unitIndex]}`;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Format an ISO datetime string for display, e.g. "Jul 5, 2026, 3:04 PM". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormatter.format(date);
}

const dateOnlyFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Format an ISO datetime string as a date only, e.g. "Jul 5, 2026". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return dateOnlyFormatter.format(date);
}

/** Debounce a fast-changing value; returns the value after `delayMs` of quiet. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
