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
});
