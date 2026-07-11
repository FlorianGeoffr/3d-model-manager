import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DuplicatesPage } from "@/pages/DuplicatesPage";
import type { DuplicatesReport } from "@/api/types";

// Mock the report hook directly (same pattern as QueuePage.test.tsx mocking
// `@/api/queue`) -- DuplicatesPage's own rendering (groups, reclaimable
// total, empty state) is what's under test here.
const { reportBox } = vi.hoisted(() => ({
  reportBox: { current: undefined as DuplicatesReport | undefined },
}));

vi.mock("@/api/reports", () => ({
  useDuplicatesReport: () => ({ data: reportBox.current, isLoading: false, isError: false }),
}));

const REPORT: DuplicatesReport = {
  groups: [
    {
      blob_hash: "abcdef0123456789",
      size: 2048,
      wasted_bytes: 2048,
      files: [
        { model_id: 1, model_slug: "dragon", model_name: "Dragon", file_id: 1, file_name: "dragon.stl" },
        { model_id: 2, model_slug: "dragon-copy", model_name: "Dragon Copy", file_id: 2, file_name: "dragon.stl" },
      ],
    },
  ],
  total_wasted_bytes: 2048,
};

function renderDuplicatesPage() {
  const rootRoute = createRootRoute();
  const duplicatesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DuplicatesPage });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([duplicatesRoute, detailRoute]),
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
  reportBox.current = undefined;
});

describe("DuplicatesPage", () => {
  it("shows an empty state when there are no duplicate groups", async () => {
    reportBox.current = { groups: [], total_wasted_bytes: 0 };

    renderDuplicatesPage();

    expect(await screen.findByText("No duplicate files found.")).toBeInTheDocument();
  });

  it("renders each group's files and the reclaimable total", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();

    expect(await screen.findByText("Reclaimable: 2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("Dragon — dragon.stl")).toBeInTheDocument();
    expect(screen.getByText("Dragon Copy — dragon.stl")).toBeInTheDocument();
  });
});
