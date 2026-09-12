/**
 * Single source of truth for the sidebar/topbar/command-palette nav (R12
 * studio shell). Grouped: LIBRARY first (day-to-day browsing), OPERATIONS
 * second (printer/jobs/queue/duplicates -- utility pages), Settings pinned
 * at the bottom outside both groups. `printer` items are filtered out by
 * the caller when `useFeatures().data?.printer_enabled` is false -- see
 * `AppSidebar`.
 */
import type { LinkProps } from "@tanstack/react-router";
import {
  Bookmark,
  CopyCheck,
  LayoutDashboard,
  ListChecks,
  ListOrdered,
  Printer,
  Settings,
  SquareLibrary,
} from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  to: LinkProps["to"];
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Gates the item behind `useFeatures().data?.printer_enabled`. */
  featureGated?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Library",
    items: [
      { to: "/", label: "Library", icon: SquareLibrary },
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/collections", label: "Collections", icon: Bookmark },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/printer", label: "Printer", icon: Printer, featureGated: true },
      { to: "/jobs", label: "Jobs", icon: ListChecks },
      { to: "/queue", label: "Queue", icon: ListOrdered },
      { to: "/duplicates", label: "Duplicates", icon: CopyCheck },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/** Flat list of every nav item (Settings included) -- the palette's "Pages"
 * section and the topbar breadcrumb's path->label lookup both want this
 * shape rather than the grouped one. */
export const ALL_NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flatMap((g) => g.items), SETTINGS_ITEM];

/** Static path -> label lookup for the breadcrumb (dynamic routes like
 * `/models/$slug` are handled separately in `TopBar`). */
export const NAV_LABELS: Record<string, string> = Object.fromEntries(
  ALL_NAV_ITEMS.map((item) => [item.to as string, item.label]),
);
