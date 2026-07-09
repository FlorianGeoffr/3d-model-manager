import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, createRoute, redirect } from "@tanstack/react-router";

import { authQueryOptions } from "@/api/auth";
import { AppShell } from "@/components/AppShell";
import { AddPage } from "@/pages/AddPage";
import { JobsPage } from "@/pages/JobsPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { LoginPage } from "@/pages/LoginPage";
import { ModelDetailPage } from "@/pages/ModelDetailPage";
import { PrinterPage } from "@/pages/PrinterPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { ViewerWindowPage } from "@/pages/ViewerWindowPage";

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

/** Pathless layout route: guards every child on `GET /auth/me` before it
 * loads, redirecting to `/login` on failure, then renders the app shell
 * (sidebar nav + outlet) around whichever child matched. */
const authenticatedRoute = createRoute({
  id: "authenticated",
  getParentRoute: () => rootRoute,
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(authQueryOptions);
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: AppShell,
});

// Standalone viewer window (M8 G1): session-guarded but OUTSIDE the AppShell
// layout (no nav rail) so `window.open('/viewer/$slug?ids=&bg=&colors=')`
// renders a bare, self-contained canvas.
const viewerWindowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/viewer/$slug",
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(authQueryOptions);
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  validateSearch: (
    search: Record<string, unknown>,
  ): { ids?: string; bg?: string; colors?: string } => ({
    ids: typeof search.ids === "string" ? search.ids : undefined,
    bg: typeof search.bg === "string" ? search.bg : undefined,
    colors: typeof search.colors === "string" ? search.colors : undefined,
  }),
  component: ViewerWindowPage,
});

const libraryRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/",
  component: LibraryPage,
});

const modelDetailRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/models/$slug",
  component: ModelDetailPage,
});

const addRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/add",
  component: AddPage,
});

// /upload and /import were consolidated into /add (M8 E2). Keep the old paths
// as redirects so existing bookmarks/links still land somewhere useful.
const uploadRedirectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/upload",
  beforeLoad: () => {
    throw redirect({ to: "/add" });
  },
  component: () => null,
});

const importRedirectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/import",
  beforeLoad: () => {
    throw redirect({ to: "/add" });
  },
  component: () => null,
});

const printerRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/printer",
  component: PrinterPage,
});

const jobsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/jobs",
  component: JobsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  viewerWindowRoute,
  authenticatedRoute.addChildren([
    libraryRoute,
    modelDetailRoute,
    addRoute,
    uploadRedirectRoute,
    importRedirectRoute,
    printerRoute,
    jobsRoute,
    settingsRoute,
  ]),
]);
