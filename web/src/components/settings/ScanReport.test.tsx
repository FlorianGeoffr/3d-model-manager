import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScanRunOut } from "@/api/types";
import { ScanReport } from "@/components/settings/ScanReport";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as SettingsPage.test.tsx), so the fakes have to be created
// through `vi.hoisted`.
const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, delete: deleteMock },
  };
});

function fakeScanRun(overrides: Partial<ScanRunOut> = {}): ScanRunOut {
  return {
    id: 1,
    created_at: "2026-07-05T00:00:00Z",
    finished_at: "2026-07-05T00:01:00Z",
    state: "done",
    files_seen: 10,
    files_hashed: 3,
    relinked: 1,
    adopted: 1,
    missing: 1,
    report: {
      adopted: [{ model_id: 5, slug: "adopted-model", revision_id: 50, files: ["a.stl", "b.stl"] }],
      relinked: [{ file_id: 11, from: "old/path.stl", to: "new/path.stl", hash: "hashrelinked123" }],
      changed: [{ file_id: 12, storage_path: "changed/path.stl", old_hash: "oldhash1234", new_hash: "newhash5678" }],
      missing: [{ file_id: 13, storage_path: "missing/path.stl", model_slug: "missing-model" }],
      errors: [{ storage_path: "broken/path.stl", error: "permission denied" }],
      verified: 7,
    },
    ...overrides,
  };
}

function mockGet(runs: ScanRunOut[]) {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith("/scan-runs")) return Promise.resolve(runs);
    return Promise.resolve([]);
  });
}

function renderScanReport() {
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: ScanReport });
  const modelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, modelRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ScanReport", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it("shows an empty state when there are no scan runs yet", async () => {
    mockGet([]);

    renderScanReport();

    expect(await screen.findByText(/No scans yet/)).toBeInTheDocument();
  });

  it("shows a couldn't-load state with a retry button on error", async () => {
    getMock.mockRejectedValue(new Error("network down"));

    renderScanReport();

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("triggers a scan when the button is clicked", async () => {
    mockGet([]);
    postMock.mockResolvedValue(fakeScanRun({ state: "queued", report: null }));

    renderScanReport();
    await screen.findByText(/No scans yet/);

    fireEvent.click(screen.getByRole("button", { name: "Run scan" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/scan"));
  });

  it("disables the Run scan button while the latest run is queued or running", async () => {
    mockGet([fakeScanRun({ state: "running", report: null })]);

    renderScanReport();

    expect(await screen.findByRole("button", { name: "Scanning..." })).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("renders the latest run's counters and state badge", async () => {
    mockGet([fakeScanRun()]);

    renderScanReport();

    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.getByText("Seen:")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("renders adopted/relinked/changed/missing/errors lists from the latest run's report", async () => {
    mockGet([fakeScanRun()]);

    renderScanReport();

    expect(await screen.findByText("Adopted (1)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "adopted-model" })).toBeInTheDocument();

    expect(screen.getByText("Relinked (1)")).toBeInTheDocument();
    expect(screen.getByText("old/path.stl")).toBeInTheDocument();
    expect(screen.getByText("new/path.stl")).toBeInTheDocument();

    expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    expect(screen.getByText("changed/path.stl")).toBeInTheDocument();

    expect(screen.getByText("Missing (1)")).toBeInTheDocument();
    expect(screen.getByText("missing/path.stl")).toBeInTheDocument();

    expect(screen.getByText("Errors (1)")).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
  });

  it("shows empty-list copy for a report section with no entries", async () => {
    mockGet([
      fakeScanRun({
        report: { adopted: [], relinked: [], changed: [], missing: [], errors: [], verified: 0 },
      }),
    ]);

    renderScanReport();

    expect(await screen.findByText("Adopted (0)")).toBeInTheDocument();
    expect(screen.getByText("No errors during the last scan.")).toBeInTheDocument();
  });

  it("resolves a missing row by deleting the file record after confirming", async () => {
    mockGet([fakeScanRun()]);
    deleteMock.mockResolvedValue(undefined);

    renderScanReport();
    await screen.findByText("Missing (1)");

    fireEvent.click(screen.getByRole("button", { name: /Remove file record/ }));
    const confirmButton = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/files/13"));
    expect(await screen.findByText("Removed.")).toBeInTheDocument();
  });
});
