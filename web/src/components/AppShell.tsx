import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Bookmark, CopyCheck, ListChecks, ListOrdered, LogOut, Plus, Printer, Settings, SquareLibrary } from "lucide-react";

import { useAuth, useLogout } from "@/api/auth";
import { useFeatures } from "@/api/features";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EventsProvider } from "@/hooks/useEvents";

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
  const navItems = NAV_ITEMS.filter((item) => item.to !== "/printer" || features.data?.printer_enabled);

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
    </EventsProvider>
  );
}
