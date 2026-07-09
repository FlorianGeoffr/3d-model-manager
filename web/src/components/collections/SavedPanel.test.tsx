import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SavedPanel } from "@/components/collections/SavedPanel";
import type { FollowedCollection, PendingImport, RemoteList } from "@/api/types";

const {
  followedBox,
  pendingBox,
  remoteListsBox,
  syncNowMock,
  approveMock,
  dismissMock,
  followMock,
  unfollowMock,
  setModeMock,
} = vi.hoisted(() => ({
  followedBox: { current: { data: [] as FollowedCollection[], isLoading: false } },
  pendingBox: { current: { data: [] as PendingImport[], isLoading: false } },
  remoteListsBox: { current: { data: [] as RemoteList[], isLoading: false } },
  syncNowMock: vi.fn(),
  approveMock: vi.fn(),
  dismissMock: vi.fn(),
  followMock: vi.fn(),
  unfollowMock: vi.fn(),
  setModeMock: vi.fn(),
}));

const idle = { isPending: false, isError: false, error: null };

vi.mock("@/api/collections", () => ({
  useFollowedCollections: () => followedBox.current,
  usePendingImports: () => pendingBox.current,
  useRemoteLists: () => remoteListsBox.current,
  useSyncCollectionsNow: () => ({ ...idle, mutate: syncNowMock }),
  useApprovePending: () => ({ ...idle, mutate: approveMock }),
  useDismissPending: () => ({ ...idle, mutate: dismissMock }),
  useFollowCollection: () => ({ ...idle, mutate: followMock }),
  useUnfollowCollection: () => ({ ...idle, mutate: unfollowMock }),
  useSetCollectionMode: () => ({ ...idle, mutate: setModeMock }),
}));

// Radix Select never opens under jsdom -- swap for a native <select>.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    children?: ReactNode;
  }) => (
    <select aria-label="Sync mode" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

function fakeFollowed(overrides: Partial<FollowedCollection> = {}): FollowedCollection {
  return {
    id: 1,
    site: "makerworld",
    list_id: "7",
    kind: "collection",
    title: "Desk stuff",
    mode: "review",
    last_synced_at: null,
    last_error: null,
    created_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

function fakePending(overrides: Partial<PendingImport> = {}): PendingImport {
  return {
    id: 11,
    collection_id: 1,
    site: "makerworld",
    external_id: "42",
    title: "Cable clip",
    url: "https://makerworld.com/en/models/42",
    thumbnail_url: null,
    created_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

function renderPanel() {
  const rootRoute = createRootRoute();
  const home = createRoute({ getParentRoute: () => rootRoute, path: "/", component: SavedPanel });
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

beforeEach(() => {
  vi.clearAllMocks();
  followedBox.current = { data: [], isLoading: false };
  pendingBox.current = { data: [], isLoading: false };
  remoteListsBox.current = { data: [], isLoading: false };
});

describe("SavedPanel", () => {
  it("runs a sync on demand", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Sync now/ }));
    expect(syncNowMock).toHaveBeenCalled();
  });

  it("lists a followed collection and switches its sync mode", async () => {
    followedBox.current = { data: [fakeFollowed()], isLoading: false };
    renderPanel();

    expect(await screen.findByText("Desk stuff")).toBeInTheDocument();
    expect(screen.getByText(/never synced/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Sync mode"), { target: { value: "auto" } });
    expect(setModeMock).toHaveBeenCalledWith({ id: 1, mode: "auto" });

    fireEvent.click(screen.getByRole("button", { name: "Unfollow" }));
    expect(unfollowMock).toHaveBeenCalledWith(1);
  });

  it("shows queued review items and imports or dismisses one", async () => {
    pendingBox.current = { data: [fakePending()], isLoading: false };
    renderPanel();

    const queue = within(await screen.findByTestId("review-queue"));
    expect(queue.getByText("Cable clip")).toBeInTheDocument();

    fireEvent.click(queue.getByRole("button", { name: "Import" }));
    expect(approveMock).toHaveBeenCalledWith(11);

    fireEvent.click(queue.getByRole("button", { name: "Dismiss" }));
    expect(dismissMock).toHaveBeenCalledWith(11);
  });

  it("explains that browsing your lists needs a signed-in site session", async () => {
    renderPanel();
    expect(await screen.findByText(/needs a signed-in session for that site/)).toBeInTheDocument();
  });

  it("follows a browsable remote list", async () => {
    remoteListsBox.current = {
      data: [{ site: "thingiverse", list_id: "likes", kind: "likes", title: "Likes", count: 3 }],
      isLoading: false,
    };
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Follow" }));
    expect(followMock).toHaveBeenCalledWith({
      site: "thingiverse",
      list_id: "likes",
      kind: "likes",
      title: "Likes",
      mode: "review",
    });
  });
});
