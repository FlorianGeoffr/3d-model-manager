import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  FolderInput,
  ListChecks,
  LogOut,
  Printer,
  Settings,
  SquareLibrary,
  Upload,
} from "lucide-react";

import { useAuth, useLogout } from "@/api/auth";
import { useFeatures } from "@/api/features";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { EventsProvider } from "@/hooks/useEvents";

const NAV_ITEMS = [
  { to: "/", label: "Library", icon: SquareLibrary },
  { to: "/upload", label: "Upload", icon: Upload },
  { to: "/import", label: "Import", icon: FolderInput },
  { to: "/printer", label: "Printer", icon: Printer },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
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
          <div className="px-4 py-4 text-base font-semibold">3D Model Manager</div>
          <nav className="flex flex-1 flex-col gap-1 px-2">
            {navItems.map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                activeOptions={{ exact: to === "/" }}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className: "bg-muted text-foreground",
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
