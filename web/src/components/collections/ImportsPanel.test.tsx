import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportsPanel } from "@/components/collections/ImportsPanel";
import type { ImportOut } from "@/api/types";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as SavedPanel.test.tsx), so the mutable boxes the tests
// write to have to be created through `vi.hoisted`.
const { importsBox, retryMock } = vi.hoisted(() => ({
  importsBox: { current: { data: [] as ImportOut[], isLoading: false } },
  retryMock: vi.fn(),
}));

vi.mock("@/api/imports", () => ({
  useImportsList: () => importsBox.current,
  useRetryImport: () => ({ mutate: retryMock, isPending: false }),
}));

function fakeImport(overrides: Partial<ImportOut> = {}): ImportOut {
  return {
    id: 1,
    url: "https://makerworld.com/en/models/1",
    site: "makerworld",
    external_id: "1",
    state: "done",
    model_id: 5,
    error: null,
    meta: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportsPanel />
    </QueryClientProvider>,
  );
}

describe("ImportsPanel", () => {
  beforeEach(() => {
    retryMock.mockReset();
    importsBox.current = { data: [], isLoading: false };
  });

  it("shows the empty state when there are no imports", () => {
    renderPanel();

    expect(screen.getByText("Recent imports")).toBeInTheDocument();
    expect(
      screen.getByText("No imports yet. Save a model from the extension or approve one from a collection review."),
    ).toBeInTheDocument();
  });

  it("renders each row's state badge, title, and relative time", () => {
    importsBox.current = {
      data: [
        fakeImport({ id: 1, state: "done", url: "https://makerworld.com/en/models/1" }),
        fakeImport({ id: 2, state: "pending", url: "https://www.thingiverse.com/thing:2" }),
        fakeImport({ id: 3, state: "downloading", url: "https://www.printables.com/model/3" }),
      ],
      isLoading: false,
    };

    renderPanel();

    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Downloading")).toBeInTheDocument();
    // No meta.title on any row -- falls back to the URL.
    expect(screen.getByText("https://makerworld.com/en/models/1")).toBeInTheDocument();
  });

  it("gives a failed row the destructive badge variant, its error text, and a Retry button", () => {
    importsBox.current = {
      data: [fakeImport({ id: 9, state: "failed", error: "Bambu session expired" })],
      isLoading: false,
    };

    renderPanel();

    const badge = screen.getByText("Failed");
    expect(badge).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByText("Bambu session expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("POSTs to /imports/{id}/retry when Retry is clicked", () => {
    importsBox.current = {
      data: [fakeImport({ id: 9, state: "failed", error: "boom" })],
      isLoading: false,
    };

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retryMock).toHaveBeenCalledWith(9);
  });

  it("caps the visible list and shows an 'and N more…' line beyond it", () => {
    importsBox.current = {
      data: Array.from({ length: 13 }, (_, i) => fakeImport({ id: i + 1, url: `https://example.com/${i + 1}` })),
      isLoading: false,
    };

    renderPanel();

    expect(screen.getAllByText("Done")).toHaveLength(10);
    expect(screen.getByText("and 3 more…")).toBeInTheDocument();
  });
});
