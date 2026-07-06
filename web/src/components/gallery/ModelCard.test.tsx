import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ModelCard } from "@/components/gallery/ModelCard";
import type { ModelSummary } from "@/api/types";

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
};

function renderCard(model: ModelSummary) {
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
  return render(<RouterProvider router={router} />);
}

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
});
