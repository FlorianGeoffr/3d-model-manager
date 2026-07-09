import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { LibraryPage } from "@/pages/LibraryPage";

// `vi.mock` factories are hoisted above the module's own top-level
// bindings, so the mock function has to be created through `vi.hoisted`.
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

// Fakes a rejecting queryFn by mocking the fetch wrapper the gallery query
// runs through (`useModelsQuery` -> `api.get`), so the real react-query
// pipeline (isError/error/refetch) is exercised end to end rather than
// stubbing the hook's return value.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
  };
});

function renderLibraryPage() {
  const rootRoute = createRootRoute();
  const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: LibraryPage });
  const uploadRoute = createRoute({ getParentRoute: () => rootRoute, path: "/upload", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([libraryRoute, uploadRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function mockGalleryOk() {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith("/models")) return Promise.resolve({ items: [], next_cursor: null });
    return Promise.resolve([]);
  });
}

function lastModelsCall(): string {
  const calls = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models"));
  const last = calls.at(-1);
  if (!last) throw new Error("no /models call recorded");
  return last[0] as string;
}

describe("LibraryPage", () => {
  it("renders an error card with a retry button when the gallery fetch fails, not the empty state", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/models")) return Promise.reject(new ApiError(500, "Database is unavailable"));
      return Promise.resolve([]);
    });

    renderLibraryPage();

    expect(await screen.findByText("Couldn't load models")).toBeInTheDocument();
    expect(screen.getByText("Database is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No models yet")).not.toBeInTheDocument();

    const callsBeforeRetry = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      const callsAfterRetry = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models")).length;
      expect(callsAfterRetry).toBeGreaterThan(callsBeforeRetry);
    });
  });

  it("filters by a single format via the chip facet, clearing back to All", async () => {
    mockGalleryOk();
    renderLibraryPage();
    await screen.findByText("No models yet");

    fireEvent.click(screen.getByRole("button", { name: "STL" }));
    await waitFor(() => expect(lastModelsCall()).toContain("format=stl"));

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(lastModelsCall()).not.toContain("format="));
  });

  it("only lets one format be active at a time (single-select chips)", async () => {
    mockGalleryOk();
    renderLibraryPage();
    await screen.findByText("No models yet");

    fireEvent.click(screen.getByRole("button", { name: "STL" }));
    await waitFor(() => expect(lastModelsCall()).toContain("format=stl"));

    fireEvent.click(screen.getByRole("button", { name: "3MF" }));
    await waitFor(() => expect(lastModelsCall()).toContain("format=3mf"));
    expect(lastModelsCall()).not.toContain("format=stl");
  });

  it("adds has_sliced=true to the gallery query when 'Sliced only' is checked", async () => {
    mockGalleryOk();
    renderLibraryPage();
    await screen.findByText("No models yet");

    fireEvent.click(screen.getByRole("checkbox", { name: "Sliced only" }));
    await waitFor(() => expect(lastModelsCall()).toContain("has_sliced=true"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Sliced only" }));
    await waitFor(() => expect(lastModelsCall()).not.toContain("has_sliced"));
  });
});
