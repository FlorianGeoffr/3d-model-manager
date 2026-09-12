import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, MenuIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NAV_LABELS } from "@/components/shell/navItems";

/** Slim topbar above the page content (R12 studio shell): a back button
 * (hidden on the library root), a breadcrumb built from the nav config plus
 * a special case for the model detail route, and a search affordance that
 * opens the command palette. Below `lg` it also carries the hamburger that
 * opens the off-canvas sidebar drawer (see `AppSidebar`). */
export function TopBar({
  onOpenPalette,
  onOpenMobileNav,
}: {
  onOpenPalette: () => void;
  onOpenMobileNav: () => void;
}) {
  const router = useRouter();
  const { pathname } = useLocation();
  // `strict: false` merges params from whichever matched route has them --
  // only `/models/$slug` does, so this is `undefined` everywhere else.
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const isHome = pathname === "/";
  const crumb = slug ? `Library / ${slug}` : (NAV_LABELS[pathname] ?? "");

  return (
    <div className="flex items-center gap-3 border-b border-border bg-background px-6 py-2.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open menu"
        className="lg:hidden"
        onClick={onOpenMobileNav}
      >
        <MenuIcon className="size-4" />
      </Button>
      {!isHome && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={() => router.history.back()}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
      <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{crumb}</div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={onOpenPalette}
      >
        <SearchIcon className="size-3.5" />
        Search
        <kbd className="rounded border border-border bg-muted px-1 text-[10px] tabular-mono">⌘K</kbd>
      </Button>
    </div>
  );
}
