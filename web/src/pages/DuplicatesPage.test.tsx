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
        {
          model_id: 1,
          model_slug: "dragon",
          model_name: "Dragon",
          model_archived: false,
          file_id: 1,
          file_name: "dragon.stl",
        },
        {
          model_id: 2,
          model_slug: "dragon-copy",
          model_name: "Dragon Copy",
          model_archived: false,
          file_id: 2,
          file_name: "dragon.stl",
        },
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

  it("labels an archived model's entry with an '(archived)' suffix, and leaves live entries unlabeled", async () => {
    // Branch 4 fix-review F4: storage is per-file, so an archived model's
    // bytes are still real wasted storage -- it stays in the report,
    // labeled rather than dropped.
    reportBox.current = {
      groups: [
        {
          ...REPORT.groups[0],
          files: [
            { ...REPORT.groups[0].files[0], model_archived: true },
            REPORT.groups[0].files[1],
          ],
        },
      ],
      total_wasted_bytes: REPORT.total_wasted_bytes,
    };

    renderDuplicatesPage();

    const archivedEntry = await screen.findByText("Dragon — dragon.stl");
    expect(archivedEntry.parentElement).toHaveTextContent("Dragon — dragon.stl (archived)");

    const liveEntry = screen.getByText("Dragon Copy — dragon.stl");
    expect(liveEntry.parentElement).not.toHaveTextContent("(archived)");
  });
});
