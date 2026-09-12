import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StatsOut } from "@/api/types";
import { DashboardPage } from "@/pages/DashboardPage";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: { ...actual.api, get: getMock } };
});

const STATS: StatsOut = {
  models: { total: 12, favorites: 3, archived: 1, drafts: 2 },
  files: {
    total: 30,
    bytes_total: 1_500_000,
    bytes_by_backend: { local: 1_000_000, s3: 500_000 },
    by_format: { stl: 20, "3mf": 10 },
  },
  tags: 5,
  collections: 2,
  prints: { total: 8, succeeded: 6, failed: 2, filament_g_total: 1234.5, duration_s_total: 36000 },
  recent: { models_added_7d: 4, prints_7d: 3 },
  jobs: { running: 1, queued: 2, failed_24h: 1 },
};

function mockGet(stats: StatsOut | null = STATS) {
  getMock.mockImplementation((path: string) => {
    if (path === "/stats") {
      return stats ? Promise.resolve(stats) : Promise.reject(new Error("boom"));
    }
    return Promise.resolve({});
  });
}

// `DashboardPage` links to `/jobs` -- give it a router context (same memory
// router pattern as `SettingsPage.test.tsx`).
function renderDashboard() {
  const rootRoute = createRootRoute();
  const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
  const jobs = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, jobs]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe("DashboardPage", () => {
  it("shows a skeleton while loading", async () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { container } = renderDashboard();

    await waitFor(() =>
      expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0),
    );
  });

  it("renders stat tiles from the mocked stats response", async () => {
    mockGet();
    renderDashboard();

    expect(await screen.findByText("12")).toBeInTheDocument(); // models total
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument(); // files total
    expect(screen.getByText("Tags")).toBeInTheDocument();
  });

  it("renders the format histogram and storage-by-backend breakdown", async () => {
    mockGet();
    renderDashboard();

    expect(await screen.findByText("stl")).toBeInTheDocument();
    expect(screen.getByText("3mf")).toBeInTheDocument();
    expect(screen.getByText(/local —/)).toBeInTheDocument();
    expect(screen.getByText(/s3 —/)).toBeInTheDocument();
  });

  it("renders printer job counts linking to Jobs", async () => {
    mockGet();
    renderDashboard();

    const link = await screen.findByRole("link", { name: "View all jobs" });
    expect(link).toHaveAttribute("href", "/jobs");
  });

  it("shows an error state when the stats fetch fails", async () => {
    mockGet(null);
    renderDashboard();

    expect(await screen.findByText("Couldn't load the dashboard")).toBeInTheDocument();
  });
});
