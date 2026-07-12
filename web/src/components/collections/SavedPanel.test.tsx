import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
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
  postMock,
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
  postMock: vi.fn(),
}));

const idle = { isPending: false, isError: false, error: null };

// `useFollowCollectionByUrl` is deliberately left as the real implementation
// (via `importOriginal`) rather than mocked like the others -- the tests
// below need to see the actual POST it makes, so only `@/api/client`'s
// `post` is stubbed (same pattern as BrowserExtensionCard.test.tsx).
vi.mock("@/api/collections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/collections")>();
  return {
    ...actual,
    useFollowedCollections: () => followedBox.current,
    usePendingImports: () => pendingBox.current,
    useRemoteLists: () => remoteListsBox.current,
    useSyncCollectionsNow: () => ({ ...idle, mutate: syncNowMock }),
    useApprovePending: () => ({ ...idle, mutate: approveMock }),
    useDismissPending: () => ({ ...idle, mutate: dismissMock }),
    useFollowCollection: () => ({ ...idle, mutate: followMock }),
    useUnfollowCollection: () => ({ ...idle, mutate: unfollowMock }),
    useSetCollectionMode: () => ({ ...idle, mutate: setModeMock }),
  };
});

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, post: postMock },
  };
});

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
  postMock.mockReset();
  window.localStorage.clear();
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

  it("groups review items by source collection, ordered by title, with a fallback label for an unfollowed collection", async () => {
    followedBox.current = {
      data: [
        fakeFollowed({ id: 2, title: "All collected models" }),
        fakeFollowed({ id: 1, title: "Desk stuff" }),
      ],
      isLoading: false,
    };
    pendingBox.current = {
      data: [
        fakePending({ id: 11, collection_id: 1, title: "Cable clip" }),
        fakePending({ id: 12, collection_id: 2, title: "Vase" }),
        fakePending({ id: 13, collection_id: 2, title: "Planter" }),
        fakePending({ id: 14, collection_id: 99, title: "Orphaned thing" }),
      ],
      isLoading: false,
    };
    renderPanel();

    const queue = within(await screen.findByTestId("review-queue"));
    const groupHeadings = queue.getAllByRole("heading", { level: 3 });
    expect(groupHeadings).toHaveLength(3);

    // Sorted alphabetically by resolved title: "All collected models" (2
    // items) < "Collection #99" (fallback for the unfollowed collection, 1
    // item) < "Desk stuff" (1 item).
    expect(groupHeadings[0]).toHaveTextContent("All collected models");
    expect(groupHeadings[0]).toHaveTextContent("2");
    expect(groupHeadings[1]).toHaveTextContent("Collection #99");
    expect(groupHeadings[2]).toHaveTextContent("Desk stuff");

    expect(queue.getByText("Cable clip")).toBeInTheDocument();
    expect(queue.getByText("Vase")).toBeInTheDocument();
    expect(queue.getByText("Planter")).toBeInTheDocument();
    expect(queue.getByText("Orphaned thing")).toBeInTheDocument();
  });

  it("renders an aligned Import/Dismiss actions row for every review card", async () => {
    pendingBox.current = {
      data: [
        fakePending({ id: 11, collection_id: 1, title: "Cable clip" }),
        fakePending({
          id: 12,
          collection_id: 1,
          title: "A much longer title that would otherwise push its buttons out of line",
        }),
      ],
      isLoading: false,
    };
    renderPanel();

    const queue = within(await screen.findByTestId("review-queue"));
    const actionRows = queue.getAllByTestId("review-item-actions");
    expect(actionRows).toHaveLength(2);
    for (const row of actionRows) {
      expect(within(row).getByRole("button", { name: "Import" })).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    }
  });

  it("collapses and re-expands the review queue, persisting the choice and flipping aria-expanded", async () => {
    pendingBox.current = { data: [fakePending()], isLoading: false };
    renderPanel();

    const toggle = await screen.findByRole("button", { name: /Review queue/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("review-queue")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("review-queue")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("review-queue-open")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("review-queue")).toBeInTheDocument();
    expect(window.localStorage.getItem("review-queue-open")).toBe("true");
  });

  it("opens the review queue by default when nothing is persisted yet, and honors a persisted collapsed state on mount", async () => {
    window.localStorage.setItem("review-queue-open", "false");
    pendingBox.current = { data: [fakePending()], isLoading: false };
    renderPanel();

    const toggle = await screen.findByRole("button", { name: /Review queue/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("review-queue")).not.toBeInTheDocument();
  });

  it("explains how to connect each site when no collections are found", async () => {
    renderPanel();
    expect(await screen.findByText(/No collections found yet/)).toBeInTheDocument();
    expect(screen.getByText(/paste your web\s+token/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
  });

  it("also points to the browser extension for MakerWorld collection sync in the empty state", async () => {
    renderPanel();
    expect(
      await screen.findByText(/Your MakerWorld collections sync from the browser extension/),
    ).toBeInTheDocument();
  });

  it("follows a browsable remote list", async () => {
    remoteListsBox.current = {
      data: [{ site: "thingiverse", list_id: "likes", kind: "likes", title: "Likes", count: 3 }],
      isLoading: false,
    };
    renderPanel();

    // Scoped to the remote-lists row -- the "Add collection by URL" form
    // above it also has a button named "Follow".
    const row = within(await screen.findByTestId("remote-lists"));
    fireEvent.click(row.getByRole("button", { name: "Follow" }));
    expect(followMock).toHaveBeenCalledWith({
      site: "thingiverse",
      list_id: "likes",
      kind: "likes",
      title: "Likes",
      mode: "review",
    });
  });

  it("follows a collection pasted as a URL and clears the input on success", async () => {
    postMock.mockResolvedValueOnce({
      id: 5,
      site: "makerworld",
      list_id: "555",
      kind: "collection",
      title: "Some collection",
      mode: "review",
      last_synced_at: null,
      last_error: null,
      created_at: "2026-07-11T00:00:00Z",
    });
    renderPanel();

    const input = await screen.findByPlaceholderText(/makerworld\.com/);
    fireEvent.change(input, { target: { value: "https://makerworld.com/en/collections/555" } });
    fireEvent.click(within(screen.getByTestId("add-collection-by-url")).getByRole("button", { name: "Follow" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/collections/from-url", {
        url: "https://makerworld.com/en/collections/555",
      }),
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("shows the API's error detail inline when following by URL fails", async () => {
    postMock.mockRejectedValueOnce(new ApiError(422, "Unsupported or invalid URL"));
    renderPanel();

    fireEvent.change(await screen.findByPlaceholderText(/makerworld\.com/), {
      target: { value: "https://example.com/not-a-collection" },
    });
    fireEvent.click(within(screen.getByTestId("add-collection-by-url")).getByRole("button", { name: "Follow" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported or invalid URL");
  });
});
