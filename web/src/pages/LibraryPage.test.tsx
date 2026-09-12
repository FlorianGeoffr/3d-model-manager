import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { LibraryPage } from "@/pages/LibraryPage";
import type { FollowedCollection, ModelSummary } from "@/api/types";

// `vi.mock` factories are hoisted above the module's own top-level
// bindings, so the mock function has to be created through `vi.hoisted`.
const { getMock, postMock, toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn().mockResolvedValue({ updated: 0 }),
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

// Fakes a rejecting queryFn by mocking the fetch wrapper the gallery query
// runs through (`useModelsQuery` -> `api.get`), so the real react-query
// pipeline (isError/error/refetch) is exercised end to end rather than
// stubbing the hook's return value. `useEnqueueModel` (bulk "Add to queue")
// also goes through this same mocked `api.post`, so per-test overrides of
// `postMock` can simulate a queue failure without mocking `@/api/queue`.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock },
  };
});

// Fix-review F3's "toast an error on total add-to-queue failure" test needs
// to observe the toast calls `SelectionActionBar.addToQueue` makes.
vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

// jsdom doesn't implement `ResizeObserver` (the virtualized grid's column
// count comes from observing the grid container's width, R9-A item 2) -- a
// minimal stub that never fires is enough: it leaves the grid at its
// smallest (2-column) layout, which every test here is fine with.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

// Radix's Popover never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation documented for `<Select>` in
// ViewerTab.test.tsx) -- render trigger/content unconditionally in place so
// the Collection (and Tags) facet's options are reachable without needing a
// real open click.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function renderLibraryPage(initialEntries: string[] = ["/"]) {
  const rootRoute = createRootRoute();
  const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: LibraryPage });
  const uploadRoute = createRoute({ getParentRoute: () => rootRoute, path: "/upload", component: () => null });
  // A modified click on a card must NOT navigate here -- so a matching
  // detail route exists to prove it (same shape as ModelCard.test.tsx).
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/models/$slug",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([libraryRoute, uploadRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries }),
  });
  // Mirrors the app's real global MutationCache error toast
  // (web/src/queryClient.ts) -- the bulk mutations deliberately have NO
  // local onError (Round 11 fix wave: a local toast would stack a second,
  // identical toast on top of this one in production), so error-path tests
  // must exercise the global handler to assert what users actually see.
  const queryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silentError) return;
        toastErrorMock(error instanceof ApiError ? error.detail : "Something went wrong");
      },
    }),
    defaultOptions: { queries: { retry: false } },
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

function mockGalleryOk() {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith("/models")) return Promise.resolve({ items: [], next_cursor: null });
    return Promise.resolve([]);
  });
}

const FOLLOWED_COLLECTION: FollowedCollection = {
  id: 5,
  site: "thingiverse",
  list_id: "list-1",
  kind: "collection",
  title: "Cool Prints",
  mode: "auto",
  last_synced_at: null,
  last_error: null,
  created_at: "2026-01-01T00:00:00Z",
};

function mockGalleryOkWithCollections(collections: FollowedCollection[]) {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith("/models")) return Promise.resolve({ items: [], next_cursor: null });
    if (path.startsWith("/collections")) return Promise.resolve(collections);
    return Promise.resolve([]);
  });
}

const GALLERY_MODEL: ModelSummary = {
  id: 1,
  slug: "test-model",
  name: "Test Model",
  description: null,
  tags: ["fantasy"],
  updated_at: "2026-06-01T12:00:00Z",
  created_at: "2026-06-01T12:00:00Z",
  file_count: 1,
  formats: ["stl"],
  cover: null,
  render_url: null,
  print_time_s: null,
  has_sliced: false,
  source_site: null,
  source_collection_id: null,
  source_collection_title: null,
  favorite: false,
};

const GALLERY_MODEL_2: ModelSummary = {
  ...GALLERY_MODEL,
  id: 2,
  slug: "test-model-2",
  name: "Test Model 2",
};

const GALLERY_MODEL_3: ModelSummary = {
  ...GALLERY_MODEL,
  id: 3,
  slug: "test-model-3",
  name: "Test Model 3",
};

const GALLERY_MODEL_4: ModelSummary = {
  ...GALLERY_MODEL,
  id: 4,
  slug: "test-model-4",
  name: "Test Model 4",
};

function mockGalleryOkWithModels(models: ModelSummary[]) {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith("/models")) return Promise.resolve({ items: models, next_cursor: null });
    return Promise.resolve([]);
  });
}

function lastModelsCall(): string {
  const calls = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models"));
  const last = calls.at(-1);
  if (!last) throw new Error("no /models call recorded");
  return last[0] as string;
}

function lastBulkCall(): { path: string; body: unknown } {
  const calls = postMock.mock.calls.filter((call: unknown[]) => (call[0] as string) === "/models/bulk");
  const last = calls.at(-1);
  if (!last) throw new Error("no /models/bulk call recorded");
  return { path: last[0] as string, body: last[1] };
}

function lastBulkDeleteCall(): { path: string; body: unknown } {
  const calls = postMock.mock.calls.filter((call: unknown[]) => (call[0] as string) === "/models/bulk-delete");
  const last = calls.at(-1);
  if (!last) throw new Error("no /models/bulk-delete call recorded");
  return { path: last[0] as string, body: last[1] };
}

beforeEach(() => {
  postMock.mockReset();
  postMock.mockResolvedValue({ updated: 0 });
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
});

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

  it("renders followed collections as options in the Collection facet", async () => {
    mockGalleryOkWithCollections([FOLLOWED_COLLECTION]);
    renderLibraryPage();
    await screen.findByText("No models yet");

    expect(await screen.findByText("Cool Prints (thingiverse)")).toBeInTheDocument();
  });

  it("filters by a followed collection via the facet, and clears back on a second click", async () => {
    mockGalleryOkWithCollections([FOLLOWED_COLLECTION]);
    renderLibraryPage();
    await screen.findByText("No models yet");

    const chip = await screen.findByText("Cool Prints (thingiverse)");
    fireEvent.click(chip);
    await waitFor(() => expect(lastModelsCall()).toContain("collection=5"));
    expect(await screen.findByRole("button", { name: "Collection: Cool Prints" })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cool Prints (thingiverse)"));
    await waitFor(() => expect(lastModelsCall()).not.toContain("collection="));
  });

  it("seeds the collection filter from a ?collection= URL search param on mount", async () => {
    mockGalleryOkWithCollections([FOLLOWED_COLLECTION]);
    renderLibraryPage(["/?collection=5"]);

    await waitFor(() => expect(lastModelsCall()).toContain("collection=5"));
    expect(await screen.findByRole("button", { name: "Collection: Cool Prints" })).toBeInTheDocument();
  });

  it("adds favorite=true to the gallery query when the Favorites facet is toggled on, and clears it back off", async () => {
    mockGalleryOk();
    renderLibraryPage();
    await screen.findByText("No models yet");

    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    await waitFor(() => expect(lastModelsCall()).toContain("favorite=true"));

    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    await waitFor(() => expect(lastModelsCall()).not.toContain("favorite="));
  });

  it("adds archived=true to the gallery query when the Include archived facet is toggled on, and clears it back off", async () => {
    mockGalleryOk();
    renderLibraryPage();
    await screen.findByText("No models yet");

    fireEvent.click(screen.getByRole("button", { name: "Include archived" }));
    await waitFor(() => expect(lastModelsCall()).toContain("archived=true"));

    fireEvent.click(screen.getByRole("button", { name: "Include archived" }));
    await waitFor(() => expect(lastModelsCall()).not.toContain("archived="));
  });

  it("select mode reveals a checkbox per card and a floating action bar once one is checked", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    expect(screen.queryByRole("checkbox", { name: "Select Test Model" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const checkbox = await screen.findByRole("checkbox", { name: "Select Test Model" });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(await screen.findByText("1 selected")).toBeInTheDocument();
  });

  it("a second Enter while the tag mutation is in flight doesn't fire a second bulk update", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    // Never settles: keeps the mutation pending so the in-flight guard is
    // what's under test, not mutation timing.
    postMock.mockImplementation(() => new Promise(() => {}));
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    const input = screen.getByRole("textbox", { name: "Tag to add" });
    fireEvent.change(input, { target: { value: "fantasy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(postMock.mock.calls.filter((call: unknown[]) => call[0] === "/models/bulk")).toHaveLength(1),
    );
  });

  it("bulk-favoriting the selection POSTs /models/bulk with the selected ids and favorite:true", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    await waitFor(() =>
      expect(lastBulkCall()).toEqual({ path: "/models/bulk", body: { ids: [1], favorite: true } }),
    );
  });

  it("toasts an error, and no success toast, when every add-to-queue call in the selection fails", async () => {
    // Fix-review F3: `Promise.allSettled` swallows rejections silently --
    // a total failure must still tell the user something went wrong.
    mockGalleryOkWithModels([GALLERY_MODEL]);
    postMock.mockImplementation((path: string) => {
      if (path === "/queue") return Promise.reject(new ApiError(409, "already queued"));
      return Promise.resolve({ updated: 0 });
    });
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));

    // Exactly ONE toast: the bulk loop marks its enqueue mutation
    // `silentError`, so the global MutationCache handler stays quiet and
    // doesn't stack a per-model toast on top of this summary.
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledExactlyOnceWith("Failed to add 1 model to queue"));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("bulk-deleting the selection POSTs /models/bulk-delete, toasts, and exits select mode", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2]);
    postMock.mockResolvedValueOnce({ deleted: 2 });
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model 2" }));
    await screen.findByText("2 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete 2 models?")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(lastBulkDeleteCall()).toEqual({ path: "/models/bulk-delete", body: { ids: [1, 2] } }),
    );
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledExactlyOnceWith("Deleted 2 models"));
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
  });

  it("canceling the delete confirm dialog doesn't POST to /models/bulk-delete", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    // Two "Close" buttons live in a `ConfirmDialog` -- the footer's labeled
    // one (index 0) and the corner icon button (sr-only "Close" text) --
    // same disambiguation as DuplicatesPage.test.tsx.
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(postMock.mock.calls.some((call: unknown[]) => call[0] === "/models/bulk-delete")).toBe(false);
    // Selection survives closing the dialog without confirming.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  it("toasts the ApiError detail and keeps the selection when the delete POST rejects", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    postMock.mockImplementationOnce(() =>
      Promise.reject(new ApiError(409, "model(s) have files still processing: [1]")),
    );
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledExactlyOnceWith("model(s) have files still processing: [1]"),
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // Action bar still present with the selection intact.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });

  function cardLink(name: string): HTMLElement {
    const link = screen.getByText(name).closest("a");
    if (!link) throw new Error(`no card link found for "${name}"`);
    return link;
  }

  it("shift-clicking two cards selects the inclusive range between them, auto-entering select mode", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2, GALLERY_MODEL_3, GALLERY_MODEL_4]);
    const { router } = renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(cardLink("Test Model"), { shiftKey: true });
    await screen.findByText("1 selected");

    fireEvent.click(cardLink("Test Model 4"), { shiftKey: true });

    expect(await screen.findByText("4 selected")).toBeInTheDocument();
    // No navigation happened on either modified click.
    expect(router.state.location.pathname).toBe("/");
  });

  it("ctrl-clicking a card toggles just that card's selection", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2]);
    const { router } = renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(cardLink("Test Model"), { ctrlKey: true });
    expect(await screen.findByText("1 selected")).toBeInTheDocument();

    fireEvent.click(cardLink("Test Model"), { ctrlKey: true });
    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("LibraryPage -- virtualized grid (R9-A item 2)", () => {
  it("renders far fewer than 200 cards in the DOM for a 200-item page", async () => {
    const models: ModelSummary[] = Array.from({ length: 200 }, (_, i) => ({
      ...GALLERY_MODEL,
      id: i + 1,
      slug: `model-${i + 1}`,
      name: `Model ${i + 1}`,
    }));
    mockGalleryOkWithModels(models);
    renderLibraryPage();

    await screen.findByText("Model 1");

    const renderedCardTitles = screen.getAllByRole("heading", { level: 3 });
    expect(renderedCardTitles.length).toBeGreaterThan(0);
    expect(renderedCardTitles.length).toBeLessThan(200);
  });

  it("fetches the next page once the last virtual row is reached and more pages exist", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/models")) {
        return Promise.resolve(
          path.includes("cursor=")
            ? { items: [], next_cursor: null }
            : { items: [GALLERY_MODEL, GALLERY_MODEL_2], next_cursor: "page-2" },
        );
      }
      return Promise.resolve([]);
    });
    renderLibraryPage();

    await screen.findByText("Test Model");

    // Two items at the default (2-column) layout is exactly one row --
    // the only, and therefore last, virtual row -- so it should trigger
    // fetchNextPage as soon as it renders.
    await waitFor(() => expect(lastModelsCall()).toContain("cursor=page-2"));
  });

  it("does not fetch a next page once hasNextPage is false", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2]);
    renderLibraryPage();

    await screen.findByText("Test Model");

    const callsMade = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models")).length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models")).length,
    ).toBe(callsMade);
  });
});

describe("LibraryPage -- keyboard shortcuts (R9-C item 5)", () => {
  it("`/` focuses the search input", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    const search = screen.getByLabelText("Search models");
    expect(search).not.toHaveFocus();

    fireEvent.keyDown(document.body, { key: "/" });
    expect(search).toHaveFocus();
  });

  it("Escape exits select mode and clears the selection", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "false");
  });

  it("Delete opens the bulk-delete confirm when there is a selection", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Test Model" }));
    await screen.findByText("1 selected");

    fireEvent.keyDown(document.body, { key: "Delete" });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete 1 model?")).toBeInTheDocument();
  });

  it("Delete does nothing when there is no selection", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.keyDown(document.body, { key: "Delete" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("mod+a selects every loaded item and enters select mode", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });

    expect(await screen.findByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a selects every loaded item once already in select mode", async () => {
    mockGalleryOkWithModels([GALLERY_MODEL, GALLERY_MODEL_2]);
    renderLibraryPage();
    await screen.findByText("Test Model");

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.keyDown(document.body, { key: "a" });

    expect(await screen.findByText("2 selected")).toBeInTheDocument();
  });
});
