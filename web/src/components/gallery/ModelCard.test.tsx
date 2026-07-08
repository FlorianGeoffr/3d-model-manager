import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelCard } from "@/components/gallery/ModelCard";
import type { ModelSummary } from "@/api/types";

// `usePatchModel` (the "Needs review" dismiss control) calls `api.patch`;
// spy on it so the dismiss test can assert the request, and so the whole
// card renders under a real QueryClient (the mutation hook needs one).
const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn().mockResolvedValue({}) }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, patch: patchMock },
  };
});

const MODEL: ModelSummary = {
  id: 1,
  slug: "articulated-dragon",
  name: "Articulated Dragon",
  description: "A flexible print-in-place dragon",
  tags: ["fantasy", "articulated", "dragon", "flexi"],
  updated_at: "2026-06-01T12:00:00Z",
  created_at: "2026-05-01T12:00:00Z",
  file_count: 3,
  formats: ["stl", "3mf"],
  cover: null,
  print_time_s: null,
  has_sliced: false,
  source_site: null,
};

function renderCard(model: ModelSummary) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const cardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ModelCard model={model} />,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/models/$slug",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([cardRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMock.mockClear();
});

describe("ModelCard", () => {
  it("renders name, first 3 tags with overflow count, format badges, and updated date", async () => {
    renderCard(MODEL);

    expect(await screen.findByText("Articulated Dragon")).toBeInTheDocument();

    // First 3 tags shown, 4th collapsed into an overflow badge.
    expect(screen.getByText("fantasy")).toBeInTheDocument();
    expect(screen.getByText("articulated")).toBeInTheDocument();
    expect(screen.getByText("dragon")).toBeInTheDocument();
    expect(screen.queryByText("flexi")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();

    // Format badges (the placeholder thumbnail also shows a "STL" monogram,
    // so scope the query to the badge row to avoid ambiguity).
    const formatBadges = within(screen.getByTestId("format-badges"));
    expect(formatBadges.getByText("STL")).toBeInTheDocument();
    expect(formatBadges.getByText("3MF")).toBeInTheDocument();

    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it("shows all tags with no overflow badge when there are 3 or fewer", async () => {
    renderCard({ ...MODEL, tags: ["fantasy", "dragon"] });

    expect(await screen.findByText("fantasy")).toBeInTheDocument();
    expect(screen.getByText("dragon")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it("shows a Sliced badge and humanized print time when both are set", async () => {
    renderCard({ ...MODEL, has_sliced: true, print_time_s: 5400 });

    const statusBadges = within(await screen.findByTestId("status-badges"));
    expect(statusBadges.getByText("Sliced")).toBeInTheDocument();
    expect(statusBadges.getByText("1h 30m")).toBeInTheDocument();
  });

  it("shows only the print-time badge when the model isn't sliced", async () => {
    renderCard({ ...MODEL, has_sliced: false, print_time_s: 2700 });

    const statusBadges = within(await screen.findByTestId("status-badges"));
    expect(statusBadges.queryByText("Sliced")).not.toBeInTheDocument();
    expect(statusBadges.getByText("45m")).toBeInTheDocument();
  });

  it("renders no status badges when the model has no sliced file and no print time", async () => {
    renderCard(MODEL);

    expect(await screen.findByText("Articulated Dragon")).toBeInTheDocument();
    expect(screen.queryByTestId("status-badges")).not.toBeInTheDocument();
  });

  it("shows a source badge when the model was imported, none for a manual model", async () => {
    renderCard({ ...MODEL, source_site: "thingiverse" });

    expect(await screen.findByTestId("source-badge")).toHaveTextContent("thingiverse");
  });

  it("renders no source badge for a manually-created model", async () => {
    renderCard(MODEL);

    expect(await screen.findByText("Articulated Dragon")).toBeInTheDocument();
    expect(screen.queryByTestId("source-badge")).not.toBeInTheDocument();
  });

  it("shows a dismissable 'Needs review' badge for an adopted model", async () => {
    renderCard({ ...MODEL, review_state: "adopted" });

    expect(await screen.findByTestId("review-badge")).toHaveTextContent("Needs review");
    expect(screen.getByRole("button", { name: "Dismiss needs review" })).toBeInTheDocument();
  });

  it("renders no 'Needs review' badge for a model that isn't adopted", async () => {
    renderCard(MODEL);

    expect(await screen.findByText("Articulated Dragon")).toBeInTheDocument();
    expect(screen.queryByTestId("review-badge")).not.toBeInTheDocument();
  });

  it("dismissing the review badge PATCHes review_state to null without navigating", async () => {
    renderCard({ ...MODEL, review_state: "adopted" });

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss needs review" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith("/models/articulated-dragon", { review_state: null });
  });
});
