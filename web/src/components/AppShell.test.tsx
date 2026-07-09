import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/AppShell";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as UploadPage.test.tsx), so the mutable box the tests write
// to has to be created through `vi.hoisted`.
const { featuresBox } = vi.hoisted(() => ({
  featuresBox: { current: { printer_enabled: false } as { printer_enabled: boolean } | undefined },
}));

vi.mock("@/api/features", () => ({
  useFeatures: () => ({ data: featuresBox.current, isLoading: false }),
}));

vi.mock("@/api/auth", () => ({
  useAuth: () => ({ data: { username: "tester" } }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

// AppShell wraps its children in the app-wide SSE `EventsProvider`, which
// normally requires a real `EventSource` (see useEvents.test.tsx) -- nav
// rendering doesn't care about SSE at all, so swap it for a passthrough
// (same pattern as UploadPage.test.tsx mocking `@/hooks/useEvents`).
vi.mock("@/hooks/useEvents", () => ({
  EventsProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function renderShell() {
  const rootRoute = createRootRoute();
  const shellRoute = createRoute({ getParentRoute: () => rootRoute, id: "shell", component: AppShell });
  const childRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: () => <div>home</div> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shellRoute.addChildren([childRoute])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("AppShell nav", () => {
  beforeEach(() => {
    featuresBox.current = { printer_enabled: false };
  });

  it("hides the Printer nav item when the printer feature flag is off", async () => {
    featuresBox.current = { printer_enabled: false };

    renderShell();

    expect(await screen.findByText("Library")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Printer/ })).not.toBeInTheDocument();
  });

  it("shows the Printer nav item when the printer feature flag is on", async () => {
    featuresBox.current = { printer_enabled: true };

    renderShell();

    expect(await screen.findByRole("link", { name: /Printer/ })).toBeInTheDocument();
  });

  it("exposes a single global Add action instead of separate Upload/Import nav items", async () => {
    renderShell();

    expect(await screen.findByRole("link", { name: /Add to library/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Upload$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Import$/ })).not.toBeInTheDocument();
  });
});
