import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RevisionsTab } from "@/components/model-detail/RevisionsTab";
import type { ModelDetail, NoteOut, RevisionDetail, RevisionSummary } from "@/api/types";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
  };
});

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation StorageLocationBar.test.tsx works
// around) -- swap it for a plain native <select> so the "From"/"To" compare
// pickers are drivable via `fireEvent.change`.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    children?: ReactNode;
  } & Record<string, unknown>) => (
    <select value={value ?? ""} onChange={(event) => onValueChange(event.target.value)} {...rest}>
      <option value="" />
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

const MODEL: ModelDetail = {
  id: 1,
  slug: "articulated-dragon",
  name: "Articulated Dragon",
  description: null,
  source_url: null,
  source_site: null,
  source_author: null,
  source_license: null,
  source_collection_id: null,
  source_collection_title: null,
  imported_at: null,
  cover_blob_hash: null,
  is_archived: false,
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  tags: [],
  current_revision: null,
  notes: [],
  backends: [],
  favorite: false,
  print_count: 0,
  last_printed_at: null,
};

const REVISIONS: RevisionSummary[] = [
  {
    id: 10,
    model_id: 1,
    number: 1,
    name: "First",
    note: null,
    dir_name: "r1",
    created_at: "2026-06-01T12:00:00Z",
    file_count: 2,
  },
  {
    id: 11,
    model_id: 1,
    number: 2,
    name: "Second",
    note: null,
    dir_name: "r2",
    created_at: "2026-06-05T12:00:00Z",
    file_count: 3,
  },
];

// At least two revisions carry notes (Round 11 T7: exercises the lifted
// drawer state) -- different counts per revision (1 vs. 2) so each drawer's
// "Notes (N)" toggle has a distinct accessible name.
const NOTES_BY_REVISION: Record<number, NoteOut[]> = {
  10: [
    { id: 900, model_id: 1, revision_id: 10, body: "First revision note", created_at: "2026-06-01T12:00:00Z", updated_at: "2026-06-01T12:00:00Z" },
  ],
  11: [
    { id: 901, model_id: 1, revision_id: 11, body: "Second revision note A", created_at: "2026-06-05T12:00:00Z", updated_at: "2026-06-05T12:00:00Z" },
    { id: 902, model_id: 1, revision_id: 11, body: "Second revision note B", created_at: "2026-06-05T12:05:00Z", updated_at: "2026-06-05T12:05:00Z" },
  ],
};

function revisionDetailFor(id: number): RevisionDetail {
  const summary = REVISIONS.find((revision) => revision.id === id);
  return {
    id,
    model_id: 1,
    number: summary?.number ?? 0,
    name: summary?.name ?? null,
    note: null,
    dir_name: summary?.dir_name ?? "",
    created_at: summary?.created_at ?? "2026-06-01T12:00:00Z",
    files: [],
    notes: NOTES_BY_REVISION[id] ?? [],
  };
}

function mockOk() {
  getMock.mockImplementation((path: string) => {
    if (path === "/models/1/revisions") return Promise.resolve(REVISIONS);
    const detailMatch = /^\/revisions\/(\d+)$/.exec(path);
    if (detailMatch) return Promise.resolve(revisionDetailFor(Number(detailMatch[1])));
    return Promise.resolve([]);
  });
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RevisionsTab model={MODEL} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockClear();
  mockOk();
});

describe("RevisionsTab -- compare-revisions thumb preview (feat/import-fidelity T4)", () => {
  it("shows no preview thumb before a revision is picked", async () => {
    renderTab();

    await screen.findByText("Compare revisions");
    expect(screen.queryByTestId("revision-thumb")).not.toBeInTheDocument();
  });

  it("shows the picked revision's assembly-thumb once selected in 'From'", async () => {
    renderTab();

    await screen.findByText("Compare revisions");
    fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "10" } });

    const thumb = await screen.findByTestId("revision-thumb");
    expect(thumb).toHaveAttribute("src", "/api/revisions/10/assembly-thumb");
  });

  it("hides the thumb gracefully if the assembly-thumb image errors (404)", async () => {
    renderTab();

    await screen.findByText("Compare revisions");
    fireEvent.change(screen.getByRole("combobox", { name: "From" }), { target: { value: "10" } });
    const thumb = await screen.findByTestId("revision-thumb");

    fireEvent.error(thumb);

    await waitFor(() => expect(screen.queryByTestId("revision-thumb")).not.toBeInTheDocument());
  });

  it("swaps the thumb when a different revision is picked", async () => {
    renderTab();

    await screen.findByText("Compare revisions");
    const fromSelect = screen.getByRole("combobox", { name: "From" });

    fireEvent.change(fromSelect, { target: { value: "10" } });
    expect(await screen.findByTestId("revision-thumb")).toHaveAttribute(
      "src",
      "/api/revisions/10/assembly-thumb",
    );

    fireEvent.change(fromSelect, { target: { value: "11" } });
    await waitFor(() =>
      expect(screen.getByTestId("revision-thumb")).toHaveAttribute("src", "/api/revisions/11/assembly-thumb"),
    );
  });
});

describe("RevisionsTab -- notes drawer expand/collapse-all (Round 11 T7)", () => {
  it("keeps every revision's notes drawer collapsed by default", async () => {
    renderTab();

    const rev1Toggle = await screen.findByRole("button", { name: "Notes (1)" });
    const rev2Toggle = await screen.findByRole("button", { name: "Notes (2)" });
    expect(rev1Toggle).toHaveAttribute("aria-expanded", "false");
    expect(rev2Toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("First revision note")).not.toBeInTheDocument();
    expect(screen.queryByText("Second revision note A")).not.toBeInTheDocument();
  });

  it("expand-all opens every revision's drawer and reveals its notes", async () => {
    renderTab();

    await screen.findByRole("button", { name: "Notes (1)" });
    fireEvent.click(screen.getByRole("button", { name: "Expand all revision notes" }));

    expect(screen.getByRole("button", { name: "Notes (1)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Notes (2)" })).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("First revision note")).toBeInTheDocument();
    expect(screen.getByText("Second revision note A")).toBeInTheDocument();
    expect(screen.getByText("Second revision note B")).toBeInTheDocument();
  });

  it("collapse-all closes every drawer again", async () => {
    renderTab();

    await screen.findByRole("button", { name: "Notes (1)" });
    fireEvent.click(screen.getByRole("button", { name: "Expand all revision notes" }));
    await screen.findByText("First revision note");

    fireEvent.click(screen.getByRole("button", { name: "Collapse all revision notes" }));

    expect(screen.getByRole("button", { name: "Notes (1)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Notes (2)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("First revision note")).not.toBeInTheDocument();
    expect(screen.queryByText("Second revision note A")).not.toBeInTheDocument();
    expect(screen.queryByText("Second revision note B")).not.toBeInTheDocument();
  });

  it("toggling one revision's drawer leaves the other untouched", async () => {
    renderTab();

    const rev1Toggle = await screen.findByRole("button", { name: "Notes (1)" });
    fireEvent.click(rev1Toggle);

    expect(rev1Toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("First revision note")).toBeInTheDocument();

    const rev2Toggle = screen.getByRole("button", { name: "Notes (2)" });
    expect(rev2Toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Second revision note A")).not.toBeInTheDocument();
  });
});
