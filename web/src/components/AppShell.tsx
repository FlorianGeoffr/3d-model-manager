import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  Bookmark,
  CopyCheck,
  HelpCircle,
  ListChecks,
  ListOrdered,
  LoaderCircleIcon,
  LogOut,
  Plus,
  Printer,
  Settings,
  SquareLibrary,
  TriangleAlertIcon,
} from "lucide-react";

import { useAuth, useLogout } from "@/api/auth";
import { useFeatures } from "@/api/features";
import { useFailedImportsCount } from "@/api/imports";
import { useScanRuns } from "@/api/scan";
import type { ScanRunOut } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EventsProvider } from "@/hooks/useEvents";
import { useHotkeys } from "@/hooks/useHotkeys";

// R9-C item 5: the full set of keyboard shortcuts across the app, kept here
// as the single source of truth for the help dialog. Each binding is
// registered independently, next to the state/mutation it acts on -- this
// list is documentation, not the wiring.
const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: "/", description: "Focus the library search" },
  { keys: "Esc", description: "Clear selection / leave select mode" },
  { keys: "A", description: "Select all loaded models (in select mode)" },
  { keys: "Ctrl/Cmd + A", description: "Select all loaded models" },
  { keys: "Delete", description: "Delete the selected models" },
  { keys: "F", description: "Toggle favorite (model page)" },
  { keys: "Shift + F", description: "Toggle fullscreen (3D viewer)" },
  { keys: "?", description: "Show this dialog" },
];

/** R9-C item 5: lists every keyboard shortcut in the app. Opened by the `?`
 * hotkey or the sidebar's "Keyboard shortcuts" button. */
function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Available anywhere they apply.</DialogDescription>
        </DialogHeader>
        <dl className="space-y-1.5">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-muted-foreground">{shortcut.description}</dt>
              <dd>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {shortcut.keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

// R9-D item 7: scan progress chip. `useScanRuns` (`@/api/scan`) already
// fetches the latest run and gets invalidated live by `useEvents.tsx`'s
// `job.updated` handler on every `scan_library` transition (queued/running/
// done/failed/skipped) -- no polling needed here at all, satisfying the
// brief's "don't poll when no scan is active" the cheap way. The backend
// has no dedicated progress-percent event; `files_hashed`/`files_seen` off
// the same `ScanRunOut` row double as the N/M count (indeterminate -- no
// "/M" -- until `files_seen` is nonzero). A per-file percent stream would be
// a cheap backend follow-up (an extra field on the existing `job.updated`
// publish) but isn't needed for a workable chip today.
const SCAN_DONE_VISIBLE_MS = 4000;

type ScanChipState =
  | { kind: "running"; run: ScanRunOut }
  | { kind: "done" }
  | { kind: "failed" };

function useScanChipState(): ScanChipState | null {
  const { data } = useScanRuns();
  const latest = data?.[0];
  // Tracks the id of the last "done" run whose 4s grace period has elapsed,
  // so the chip disappears after done but a BRAND NEW run (a different id)
  // still shows again even if it also ends in "done".
  const [expiredDoneId, setExpiredDoneId] = useState<number | null>(null);

  useEffect(() => {
    if (!latest || latest.state !== "done") return;
    const id = window.setTimeout(() => setExpiredDoneId(latest.id), SCAN_DONE_VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [latest]);

  if (!latest) return null;
  if (latest.state === "queued" || latest.state === "running") return { kind: "running", run: latest };
  if (latest.state === "failed") return { kind: "failed" };
  if (latest.state === "done" && latest.id !== expiredDoneId) return { kind: "done" };
  return null; // "skipped", or a "done" run past its 4s grace period
}

/** Renders next to the sidebar nav (this app has no separate top header --
 * see `AppShell`'s layout). Hidden entirely with no scan in flight/recently
 * finished; clicking any variant navigates to the Jobs page, same as the
 * failure case's explicit link in the brief. */
function ScanChip() {
  const navigate = useNavigate();
  const state = useScanChipState();
  if (!state) return null;

  function goToJobs() {
    void navigate({ to: "/jobs" });
  }

  if (state.kind === "failed") {
    return (
      <button
        type="button"
        onClick={goToJobs}
        className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20"
      >
        <TriangleAlertIcon className="size-3.5" />
        Scan failed
      </button>
    );
  }

  if (state.kind === "done") {
    return (
      <button
        type="button"
        onClick={goToJobs}
        className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
      >
        Scan done
      </button>
    );
  }

  const { run } = state;
  const label = run.files_seen > 0 ? `Scanning… ${run.files_hashed}/${run.files_seen}` : "Scanning…";

  return (
    <button
      type="button"
      onClick={goToJobs}
      className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
    >
      <LoaderCircleIcon className="size-3.5 animate-spin" />
      {label}
    </button>
  );
}

// Upload + Import used to be separate nav items; they now live behind the
// single global "Add to library" action (Workstream E consolidates them onto
// /add — until then this points at /upload).
//
// "Collections" is a rail entry rather than a tab inside /add because saved-list
// sync is recurring work, not a one-off add: when it lived as a "Saved" tab
// behind the "Add to library" button, no nav label anywhere said "collection" or
// "sync" and users simply could not find it.
const NAV_ITEMS = [
  { to: "/", label: "Library", icon: SquareLibrary },
  { to: "/collections", label: "Collections", icon: Bookmark },
  { to: "/printer", label: "Printer", icon: Printer },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  // Queue and Duplicates are both utility pages -- grouped after Jobs,
  // before Settings.
  { to: "/queue", label: "Queue", icon: ListOrdered },
  { to: "/duplicates", label: "Duplicates", icon: CopyCheck },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell() {
  const { data: me } = useAuth();
  const logout = useLogout();
  const navigate = useNavigate();
  const features = useFeatures();
  // Import-health task T3: how many imports currently need attention.
  // Deliberately not `useImportsList()` -- that hook polls while anything is
  // mid-flight, and AppShell is mounted on every page, so giving it that
  // poll would run it app-wide forever (see `useFailedImportsCount`'s doc).
  const failedImports = useFailedImportsCount();
  const navItems = NAV_ITEMS.filter((item) => item.to !== "/printer" || features.data?.printer_enabled);

  // R9-C item 5: `?` opens the shortcuts dialog from anywhere in the app --
  // AppShell is mounted on every page, same reasoning as `useFailedImportsCount`
  // above.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useHotkeys({ "?": () => setShortcutsOpen(true) });

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => void navigate({ to: "/login" }),
    });
  }

  return (
    <EventsProvider>
      <div className="flex min-h-svh">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <div className="px-4 py-4 text-base font-semibold tracking-tight">3D Model Manager</div>
          <div className="px-2 pb-2">
            <Button asChild className="w-full justify-start gap-2">
              <Link to="/add">
                <Plus className="size-4" /> Add to library
              </Link>
            </Button>
          </div>
          <ScanChip />
          <nav className="flex flex-1 flex-col gap-1 px-2">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === "/" }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className: "bg-muted font-medium text-foreground",
                }}
              >
                <Icon className="size-4" />
                {label}
                {to === "/collections" && failedImports > 0 ? (
                  <span
                    className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
                    aria-label={`${failedImports} failed import${failedImports === 1 ? "" : "s"}`}
                  >
                    {failedImports}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <span className="truncate text-sm text-muted-foreground">{me?.username}</span>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Keyboard shortcuts"
                onClick={() => setShortcutsOpen(true)}
              >
                <HelpCircle className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Log out"
                onClick={handleLogout}
                disabled={logout.isPending}
              >
                <LogOut className="size-4" />
              </Button>
            </div>
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </EventsProvider>
  );
}
