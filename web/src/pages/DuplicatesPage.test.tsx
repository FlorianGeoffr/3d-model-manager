import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { modelQueryOptions } from "@/api/library";
import { duplicatesReportQueryOptions } from "@/api/reports";
import { DuplicatesPage } from "@/pages/DuplicatesPage";
import type { DuplicatesReport, DuplicatesResolveOut } from "@/api/types";

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
// Round 11 T4's `useResolveDuplicates` reuses the real hook too, so its POST
// goes through this same mocked `api.post`; `sonner`'s `toast` is mocked
// separately to assert the success/skip/error toasts it fires.
const { deleteMock, postMock, toastSuccessMock, toastWarningMock, toastErrorMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  postMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastWarningMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, delete: deleteMock, post: postMock },
  };
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, warning: toastWarningMock, error: toastErrorMock },
}));

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
          is_current_revision: true,
        },
        {
          model_id: 2,
          model_slug: "dragon-copy",
          model_name: "Dragon Copy",
          model_archived: false,
          file_id: 2,
          file_name: "dragon.stl",
          is_current_revision: true,
        },
      ],
    },
  ],
  total_wasted_bytes: 2048,
};

// A second group so "Delete all duplicates" has more than one group's
// default keeper to POST, and so a per-group action can be asserted as
// scoped to ONE group rather than trivially "the only group".
const REPORT_TWO_GROUPS: DuplicatesReport = {
  groups: [
    REPORT.groups[0],
    {
      blob_hash: "ffff000011112222",
      size: 4096,
      wasted_bytes: 4096,
      files: [
        {
          model_id: 3,
          model_slug: "goblin",
          model_name: "Goblin",
          model_archived: false,
          file_id: 10,
          file_name: "goblin.stl",
          is_current_revision: true,
        },
        {
          model_id: 4,
          model_slug: "goblin-copy",
          model_name: "Goblin Copy",
          model_archived: false,
          file_id: 11,
          file_name: "goblin.stl",
          is_current_revision: true,
        },
      ],
    },
  ],
  total_wasted_bytes: REPORT.total_wasted_bytes + 4096,
};

// A third, superseded-revision copy in the same group: keeper-eligible but
// never counted as deletable, since the server would skip it anyway (file
// ops are current-revision-only).
const REPORT_WITH_OLD_REVISION: DuplicatesReport = {
  groups: [
    {
      ...REPORT.groups[0],
      wasted_bytes: 4096,
      files: [
        REPORT.groups[0].files[0],
        REPORT.groups[0].files[1],
        {
          model_id: 5,
          model_slug: "dragon-old",
          model_name: "Dragon Old",
          model_archived: false,
          file_id: 3,
          file_name: "dragon.stl",
          is_current_revision: false,
        },
      ],
    },
  ],
  total_wasted_bytes: 4096,
};

// A group whose ONLY extra copy sits on an old revision: nothing is
// deletable anywhere on the page (fix wave: the page-wide button must be
// disabled, not offer a "Delete 0 duplicate copies?" confirm).
const REPORT_ONLY_OLD_EXTRA: DuplicatesReport = {
  groups: [
    {
      ...REPORT.groups[0],
      files: [REPORT.groups[0].files[0], REPORT_WITH_OLD_REVISION.groups[0].files[2]],
    },
  ],
  total_wasted_bytes: 2048,
};

const RESOLVE_RESULT: DuplicatesResolveOut = { deleted: 1, reclaimed_bytes: 2048, skipped: [] };

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

// Scopes into one group's card by its (12-char, truncated) blob-hash title,
// so a per-group action (e.g. "Delete extras") can be targeted without
// tripping over the same-named button in another group's card.
async function findGroupCard(blobHashPrefix: string) {
  const title = await screen.findByText(blobHashPrefix);
  const card = title.closest('[data-slot="card"]');
  if (!card) throw new Error(`card for "${blobHashPrefix}" not found`);
  return card as HTMLElement;
}

beforeEach(() => {
  reportBox.current = undefined;
  deleteMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue(RESOLVE_RESULT);
  toastSuccessMock.mockReset();
  toastWarningMock.mockReset();
  toastErrorMock.mockReset();
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

describe("DuplicatesPage -- resolve duplicates (keeper picker + delete extras)", () => {
  it("'Delete all duplicates' shows the total deletable count and POSTs each group's default keeper", async () => {
    reportBox.current = REPORT_TWO_GROUPS;

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete all duplicates" }));
    const dialog = await screen.findByRole("dialog");
    // One deletable copy per group (2 files each, default keeper = files[0]).
    expect(within(dialog).getByText("Delete 2 duplicate copies?")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledExactlyOnceWith("/reports/duplicates/resolve", {
        keep: [
          { blob_hash: "abcdef0123456789", file_id: 1 },
          { blob_hash: "ffff000011112222", file_id: 10 },
        ],
      }),
    );
  });

  it("changing a group's keeper radio then that group's 'Delete extras' POSTs only that group's new keeper", async () => {
    reportBox.current = REPORT_TWO_GROUPS;

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("radio", { name: "Keep Dragon Copy — dragon.stl" }));

    const card = await findGroupCard("abcdef012345");
    fireEvent.click(within(card).getByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledExactlyOnceWith("/reports/duplicates/resolve", {
        keep: [{ blob_hash: "abcdef0123456789", file_id: 2 }],
      }),
    );
  });

  it("a response with skipped entries fires a skip toast alongside the success toast", async () => {
    reportBox.current = REPORT;
    postMock.mockResolvedValue({
      deleted: 1,
      reclaimed_bytes: 2048,
      skipped: [{ file_id: 5, reason: "store_pending" }],
    });

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Deleted 1 copy · reclaimed 2.0 KB"));
    expect(toastWarningMock).toHaveBeenCalledWith("Skipped 1 copy (files still processing or changed since the report)");
  });

  it("suppresses the skip toast for old-revision skips the UI never promised to delete", async () => {
    // Fix wave: old-revision copies are excluded from the dialog's count and
    // badged in the list -- warning about their (expected) server-side skip
    // would contradict the UI's own promise.
    reportBox.current = REPORT;
    postMock.mockResolvedValue({
      deleted: 1,
      reclaimed_bytes: 2048,
      skipped: [{ file_id: 5, reason: "not_current_revision" }],
    });

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Deleted 1 copy · reclaimed 2.0 KB"));
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it("cancelling either the per-group or the page-wide dialog makes no resolve request", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("button", { name: "Delete extras" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Delete all duplicates" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(postMock).not.toHaveBeenCalled();
  });

  it("disables 'Delete all duplicates' when nothing on the page is deletable", async () => {
    reportBox.current = REPORT_ONLY_OLD_EXTRA;

    renderDuplicatesPage();

    const deleteAll = await screen.findByRole("button", { name: /Delete all duplicates/ });
    expect(deleteAll).toBeDisabled();
    // The per-group button agrees.
    expect(screen.getByRole("button", { name: "Delete extras" })).toBeDisabled();
  });

  it("falls back to the default keeper when the stored choice is no longer in the group", async () => {
    // Fix wave: pick a keeper, then simulate the report refetching WITHOUT
    // that file (its row was deleted some other way). Honoring the stored
    // choice would inflate the count and 404 the resolve request
    // server-side -- the group must re-default to files[0] instead.
    reportBox.current = REPORT;

    renderDuplicatesPage();

    fireEvent.click(await screen.findByRole("radio", { name: "Keep Dragon Copy — dragon.stl" }));

    // The refetched group no longer contains file_id 2 (the stored keeper);
    // a new third copy keeps the group alive. Toggling the group's collapse
    // re-renders the page against the swapped report box.
    reportBox.current = {
      groups: [
        {
          ...REPORT.groups[0],
          files: [
            REPORT.groups[0].files[0],
            {
              model_id: 6,
              model_slug: "dragon-nine",
              model_name: "Dragon Nine",
              model_archived: false,
              file_id: 9,
              file_name: "dragon.stl",
              is_current_revision: true,
            },
          ],
        },
      ],
      total_wasted_bytes: 2048,
    };
    const groupToggle = screen.getByRole("button", { name: /abcdef012345/ });
    fireEvent.click(groupToggle);
    fireEvent.click(groupToggle);

    // Default keeper (file 1) is checked again -- not "no radio checked".
    expect(await screen.findByRole("radio", { name: "Keep Dragon — dragon.stl" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete 1 duplicate copy?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledExactlyOnceWith("/reports/duplicates/resolve", {
        keep: [{ blob_hash: "abcdef0123456789", file_id: 1 }],
      }),
    );
  });

  it("an old-revision row shows a badge and is excluded from the deletable count", async () => {
    reportBox.current = REPORT_WITH_OLD_REVISION;

    renderDuplicatesPage();

    const oldRow = (await screen.findByText("Dragon Old — dragon.stl")).closest("li");
    if (!oldRow) throw new Error("row for the old-revision copy not found");
    expect(within(oldRow as HTMLElement).getByText("old revision")).toBeInTheDocument();

    // Keeper defaults to file_id 1 (files[0]); only file_id 2 is a
    // deletable current-revision copy -- the old-revision file_id 3 is
    // excluded even though it's not the keeper.
    fireEvent.click(screen.getByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete 1 duplicate copy?")).toBeInTheDocument();
  });
});

describe("DuplicatesPage -- collapsible groups (Round 11 T7)", () => {
  it("shows every group's file rows open by default", async () => {
    reportBox.current = REPORT_TWO_GROUPS;

    renderDuplicatesPage();

    expect(await screen.findByText("Dragon — dragon.stl")).toBeInTheDocument();
    expect(screen.getByText("Dragon Copy — dragon.stl")).toBeInTheDocument();
    expect(screen.getByText("Goblin — goblin.stl")).toBeInTheDocument();
    expect(screen.getByText("Goblin Copy — goblin.stl")).toBeInTheDocument();
  });

  it("collapse-all hides every group's file rows, and expand-all restores them", async () => {
    reportBox.current = REPORT_TWO_GROUPS;

    renderDuplicatesPage();
    await screen.findByText("Dragon — dragon.stl");

    fireEvent.click(screen.getByRole("button", { name: "Collapse all duplicate groups" }));

    expect(screen.queryByText("Dragon — dragon.stl")).not.toBeInTheDocument();
    expect(screen.queryByText("Goblin — goblin.stl")).not.toBeInTheDocument();
    // The toggle buttons stay put -- just collapsed.
    expect(screen.getByRole("button", { name: /abcdef012345/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /ffff00001111/ })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Expand all duplicate groups" }));

    expect(await screen.findByText("Dragon — dragon.stl")).toBeInTheDocument();
    expect(screen.getByText("Goblin — goblin.stl")).toBeInTheDocument();
  });

  it("'Delete extras' stays clickable and still opens its confirm dialog while its group is collapsed", async () => {
    reportBox.current = REPORT;

    renderDuplicatesPage();
    const groupToggle = await screen.findByRole("button", { name: /abcdef012345/ });

    fireEvent.click(groupToggle);
    expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Dragon — dragon.stl")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete extras" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete 1 duplicate copy?")).toBeInTheDocument();
  });
});
