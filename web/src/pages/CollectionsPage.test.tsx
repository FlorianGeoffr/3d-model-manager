import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CollectionsPage } from "@/pages/CollectionsPage";

// `SavedPanel`'s own behavior is covered in depth by SavedPanel.test.tsx; here
// we only prove the new top-level page actually mounts it, so the feature is
// reachable from the nav rail rather than buried in a tab under "Add".
const idle = { isPending: false, isError: false, error: null };
const empty = { data: [], isLoading: false };

vi.mock("@/api/collections", () => ({
  useFollowedCollections: () => empty,
  usePendingImports: () => empty,
  useRemoteLists: () => empty,
  useSyncCollectionsNow: () => ({ ...idle, mutate: vi.fn() }),
  useApprovePending: () => ({ ...idle, mutate: vi.fn() }),
  useDismissPending: () => ({ ...idle, mutate: vi.fn() }),
  useFollowCollection: () => ({ ...idle, mutate: vi.fn() }),
  useFollowCollectionByUrl: () => ({ ...idle, mutate: vi.fn() }),
  useUnfollowCollection: () => ({ ...idle, mutate: vi.fn() }),
  useSetCollectionMode: () => ({ ...idle, mutate: vi.fn() }),
}));

// `ImportsPanel`'s own behavior is covered by ImportsPanel.test.tsx; here it
// just needs to not make a real network call when the page mounts it.
vi.mock("@/api/imports", () => ({
  useImportsList: () => empty,
  useRetryImport: () => ({ ...idle, mutate: vi.fn() }),
}));

// Radix Select never opens under jsdom -- swap for a native <select>.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => <select>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

function renderPage() {
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: CollectionsPage,
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("CollectionsPage", () => {
  it("renders the Collections heading and the saved-collections panel", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeInTheDocument();
    expect(screen.getByText("Followed collections")).toBeInTheDocument();
    expect(screen.getByText("Your collections on each site")).toBeInTheDocument();
    expect(screen.getByText("Recent imports")).toBeInTheDocument();
  });
});
