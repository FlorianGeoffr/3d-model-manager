import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { modelQueryOptions } from "@/api/library";
import { duplicatesReportQueryOptions } from "@/api/reports";
import { DuplicatesPage } from "@/pages/DuplicatesPage";
import type { DuplicatesReport } from "@/api/types";

// Mock the report hook directly (same pattern as QueuePage.test.tsx mocking
// `@/api/queue`) -- DuplicatesPage's own rendering (groups, reclaimable
// total, empty state) is what's under test here. `duplicatesReportQueryOptions`
// is left as the real export (a plain descriptor object, no network call) so
// the delete flow's invalidation can be asserted against its real queryKey.
const { reportBox } = vi.hoisted(() => ({
  reportBox: { current: undefined as DuplicatesReport | undefined },
}));

vi.mock("@/api/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/reports")>();
  return {
    ...actual,
    useDuplicatesReport: () => ({ data: reportBox.current, isLoading: false, isError: false }),
  };
});

// The row delete button reuses the real `useDeleteFile` (from `@/api/library`,
// unmocked) so only the underlying `api.delete` transport is faked -- same
// `vi.hoisted` + `vi.mock("@/api/client", ...)` pattern as SettingsPage.test.tsx.
const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, delete: deleteMock },
  };
});

const REPORT: DuplicatesReport = {
  groups: [
    {
      blob_hash: "abcdef0123456789",
      size: 2048,
      wasted_bytes: 2048,
      files: [
        {
          model_id: 1,
          model_slug: "dragon",
          model_name: "Dragon",
          model_archived: false,
          file_id: 1,
          file_name: "dragon.stl",
        },
        {
          model_id: 2,
          model_slug: "dragon-copy",
          model_name: "Dragon Copy",
          model_archived: false,
          file_id: 2,
          file_name: "dragon.stl",
        },
      ],
    },
  ],
  total_wasted_bytes: 2048,
};

function renderDuplicatesPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const rootRoute = createRootRoute();
  const duplicatesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DuplicatesPage });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([duplicatesRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// Both rows in `REPORT` share the file name "dragon.stl", so the delete
// button's aria-label ("Delete dragon.stl") isn't unique on its own --
// scope through the row's `<li>` the same way SettingsPage.test.tsx scopes
// through a table row.
async function findRow(linkText: string) {
  const row = (await screen.findByText(linkText)).closest("li");
  if (!row) throw new Error(`row for "${linkText}" not found`);
  return row;
}

beforeEach(() => {
  reportBox.current = undefined;
  deleteMock.mockReset();
});

describe("DuplicatesPage", () => {
  it("shows an empty state when there are no duplicate groups", async () => {
    reportBox.current = { groups: [], total_wasted_bytes: 0 };

    renderDuplicatesPage();

    expect(await screen.findByText("No duplicate files found.")).toBeInTheDocument();
  });

  it("renders each group's files and the reclaimable total", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();

    expect(await screen.findByText("Reclaimable: 2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("Dragon — dragon.stl")).toBeInTheDocument();
    expect(screen.getByText("Dragon Copy — dragon.stl")).toBeInTheDocument();
  });

  it("labels an archived model's entry with an '(archived)' suffix, and leaves live entries unlabeled", async () => {
    // Branch 4 fix-review F4: storage is per-file, so an archived model's
    // bytes are still real wasted storage -- it stays in the report,
    // labeled rather than dropped.
    reportBox.current = {
      groups: [
        {
          ...REPORT.groups[0],
          files: [
            { ...REPORT.groups[0].files[0], model_archived: true },
            REPORT.groups[0].files[1],
          ],
        },
      ],
      total_wasted_bytes: REPORT.total_wasted_bytes,
    };

    renderDuplicatesPage();

    const archivedEntry = await screen.findByText("Dragon — dragon.stl");
    expect(archivedEntry.parentElement).toHaveTextContent("Dragon — dragon.stl (archived)");

    const liveEntry = screen.getByText("Dragon Copy — dragon.stl");
    expect(liveEntry.parentElement).not.toHaveTextContent("(archived)");
  });

  it("still links each row to its own model", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();

    const dragonLink = await screen.findByRole("link", { name: "Dragon — dragon.stl" });
    expect(dragonLink).toHaveAttribute("href", "/models/dragon");

    const dragonCopyLink = screen.getByRole("link", { name: "Dragon Copy — dragon.stl" });
    expect(dragonCopyLink).toHaveAttribute("href", "/models/dragon-copy");
  });
});

describe("DuplicatesPage -- gated quick delete", () => {
  it("confirm-gated delete calls DELETE /files/{id} and invalidates the report and the model", async () => {
    reportBox.current = REPORT;
    deleteMock.mockResolvedValue(undefined);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderDuplicatesPage(queryClient);

    fireEvent.click(within(await findRow("Dragon — dragon.stl")).getByRole("button", { name: "Delete dragon.stl" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this copy?")).toBeInTheDocument();
    expect(
      within(dialog).getByText('Removes "dragon.stl" from Dragon and its stored bytes. This cannot be undone.'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledExactlyOnceWith("/files/1"));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: duplicatesReportQueryOptions.queryKey }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: modelQueryOptions("dragon").queryKey });
  });

  it("targets the delete at the row's own file/model, not the other duplicate", async () => {
    reportBox.current = REPORT;
    deleteMock.mockResolvedValue(undefined);

    renderDuplicatesPage();

    fireEvent.click(
      within(await findRow("Dragon Copy — dragon.stl")).getByRole("button", { name: "Delete dragon.stl" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledExactlyOnceWith("/files/2"));
  });

  it("cancelling the confirm dialog leaves the file in place and never calls delete", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();

    fireEvent.click(within(await findRow("Dragon — dragon.stl")).getByRole("button", { name: "Delete dragon.stl" }));
    const dialog = await screen.findByRole("dialog");

    // Two "Close" buttons live in a `ConfirmDialog` -- the footer's labeled
    // close action (DialogFooter's `showCloseButton`) and DialogContent's own
    // top-right X, both accessibly named "Close". The footer one renders
    // first in DOM order.
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteMock).not.toHaveBeenCalled();
    expect(screen.getByText("Dragon — dragon.stl")).toBeInTheDocument();
  });
});
