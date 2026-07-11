import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QueuePage } from "@/pages/QueuePage";
import type { QueueEntry } from "@/api/types";

// Mock the queue hooks directly (same pattern as AppShell.test.tsx mocking
// `@/api/auth`/`@/api/features`) -- QueuePage's own logic (ordering, the
// up/down position math, empty state) is what's under test, not the
// underlying fetch plumbing (already covered by the api-hook conventions
// shared with `library.ts`/`jobs.ts`).
const { queueDataBox, moveMock, removeMock } = vi.hoisted(() => ({
  queueDataBox: { current: [] as QueueEntry[] },
  moveMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock("@/api/queue", () => ({
  useQueue: () => ({ data: queueDataBox.current, isLoading: false, isError: false }),
  useMoveQueueEntry: () => ({ mutate: moveMock, isPending: false }),
  useRemoveQueueEntry: () => ({ mutate: removeMock, isPending: false }),
}));

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 1,
    model_id: 1,
    position: 1,
    added_at: "2026-06-01T12:00:00Z",
    model: {
      id: 1,
      slug: "articulated-dragon",
      name: "Articulated Dragon",
      description: null,
      tags: [],
      updated_at: "2026-06-01T12:00:00Z",
      created_at: "2026-06-01T12:00:00Z",
      file_count: 1,
      formats: ["stl"],
      cover: null,
      print_time_s: null,
      has_sliced: false,
      source_site: null,
      source_collection_id: null,
      source_collection_title: null,
      favorite: false,
    },
    ...overrides,
  };
}

function renderQueuePage() {
  const rootRoute = createRootRoute();
  const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: QueuePage });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([queueRoute, detailRoute]),
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
  queueDataBox.current = [];
  moveMock.mockClear();
  removeMock.mockClear();
});

describe("QueuePage", () => {
  it("shows an inviting empty state when the queue is empty", async () => {
    renderQueuePage();

    expect(await screen.findByText(/Your print queue is empty/)).toBeInTheDocument();
  });

  it("renders entries in order with their position", async () => {
    queueDataBox.current = [
      entry({ id: 1, position: 1, model: { ...entry().model, name: "First Model" } }),
      entry({ id: 2, position: 2, model: { ...entry().model, slug: "second-model", name: "Second Model" } }),
    ];

    renderQueuePage();

    expect(await screen.findByText("First Model")).toBeInTheDocument();
    expect(screen.getByText("Second Model")).toBeInTheDocument();
    const positions = screen.getAllByText(/^[12]$/).map((node) => node.textContent);
    expect(positions).toEqual(["1", "2"]);
  });

  it("moving an entry up calls move with position - 1", async () => {
    queueDataBox.current = [
      entry({ id: 1, position: 1 }),
      entry({ id: 2, position: 2, model: { ...entry().model, slug: "second-model", name: "Second Model" } }),
    ];

    renderQueuePage();
    await screen.findByText("Second Model");

    fireEvent.click(screen.getByRole("button", { name: "Move Second Model up" }));

    await waitFor(() => expect(moveMock).toHaveBeenCalledExactlyOnceWith({ entryId: 2, position: 1 }));
  });

  it("moving an entry down calls move with position + 1", async () => {
    queueDataBox.current = [
      entry({ id: 1, position: 1 }),
      entry({ id: 2, position: 2, model: { ...entry().model, slug: "second-model", name: "Second Model" } }),
    ];

    renderQueuePage();
    await screen.findByText("Articulated Dragon");

    fireEvent.click(screen.getByRole("button", { name: "Move Articulated Dragon down" }));

    await waitFor(() => expect(moveMock).toHaveBeenCalledExactlyOnceWith({ entryId: 1, position: 2 }));
  });

  it("disables up on the first entry and down on the last entry", async () => {
    queueDataBox.current = [
      entry({ id: 1, position: 1 }),
      entry({ id: 2, position: 2, model: { ...entry().model, slug: "second-model", name: "Second Model" } }),
    ];

    renderQueuePage();
    await screen.findByText("Second Model");

    expect(screen.getByRole("button", { name: "Move Articulated Dragon up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Second Model down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Articulated Dragon down" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Second Model up" })).not.toBeDisabled();
  });

  it("removing an entry calls the delete mutation with its id", async () => {
    queueDataBox.current = [entry({ id: 7, position: 1 })];

    renderQueuePage();
    await screen.findByText("Articulated Dragon");

    fireEvent.click(screen.getByRole("button", { name: "Remove Articulated Dragon from queue" }));

    await waitFor(() => expect(removeMock).toHaveBeenCalledExactlyOnceWith(7));
  });

  it("gives each entry's Remove button its own accessible name so they aren't ambiguous", async () => {
    // Fix-review F2: two Remove buttons with the bare name "Remove" are
    // indistinguishable to assistive tech / role queries.
    queueDataBox.current = [
      entry({ id: 1, position: 1 }),
      entry({ id: 2, position: 2, model: { ...entry().model, slug: "second-model", name: "Second Model" } }),
    ];

    renderQueuePage();
    await screen.findByText("Second Model");

    expect(screen.getByRole("button", { name: "Remove Articulated Dragon from queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Second Model from queue" })).toBeInTheDocument();
    expect(screen.getAllByText("Remove")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove Second Model from queue" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledExactlyOnceWith(2));
  });
});
