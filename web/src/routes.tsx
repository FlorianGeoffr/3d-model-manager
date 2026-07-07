import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, createRoute, redirect } from "@tanstack/react-router";

import { authQueryOptions } from "@/api/auth";
import { AppShell } from "@/components/AppShell";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { LoginPage } from "@/pages/LoginPage";
import { ModelDetailPage } from "@/pages/ModelDetailPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { UploadPage } from "@/pages/UploadPage";

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

const uploadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/upload",
  component: UploadPage,
});

const importRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/import",
  component: () => <ComingSoonPage title="Import" />,
});

const printerRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/printer",
  component: () => <ComingSoonPage title="Printer" />,
});

const jobsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/jobs",
  component: () => <ComingSoonPage title="Jobs" />,
});

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: SettingsPage,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    libraryRoute,
    modelDetailRoute,
    uploadRoute,
    importRoute,
    printerRoute,
    jobsRoute,
    settingsRoute,
  ]),
]);
