import type { TagColor } from "@/api/types";

/**
 * Fixed 10-key palette for user tags (R11-C item 16). Keys mirror the
 * backend's `TagColor` Literal (`app/schemas/library.py`) 1:1 -- a tag's
 * `color` is always one of these or `null`/`undefined` (uncolored, renders
 * with the default "secondary" badge look, no class from here).
 *
 * Each entry is a full Tailwind class string (not composed piecewise) so
 * the classes survive Tailwind's content-scan; light values first, `dark:`
 * variants alongside since this is consumed as a plain className, not
 * itself theme-aware.
 */
export const TAG_COLORS: readonly TagColor[] = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
];

const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300",
  red: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  green: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  pink: "bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300",
};

/** Badge className for a tag color, or `undefined` for an uncolored tag
 * (falls back to the badge's own default "secondary" variant styling). */
export function tagColorClass(color: TagColor | null | undefined): string | undefined {
  return color ? TAG_COLOR_CLASSES[color] : undefined;
}

/** Small solid swatch className, for the color-picker itself. */
export function tagSwatchClass(color: TagColor): string {
  const swatch: Record<TagColor, string> = {
    slate: "bg-slate-400",
    red: "bg-red-400",
    orange: "bg-orange-400",
    amber: "bg-amber-400",
    green: "bg-green-400",
    teal: "bg-teal-400",
    blue: "bg-blue-400",
    indigo: "bg-indigo-400",
    violet: "bg-violet-400",
    pink: "bg-pink-400",
  };
  return swatch[color];
}
