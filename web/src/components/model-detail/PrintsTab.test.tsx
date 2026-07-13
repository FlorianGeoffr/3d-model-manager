import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { PrintsTab } from "@/components/model-detail/PrintsTab";
import type { ModelDetail, ModelSummary, PrintEntry, QueueEntry } from "@/api/types";

// `vi.mock` factories are hoisted above the module's own top-level bindings,
// so the fakes have to be created through `vi.hoisted` (same pattern as
// ModelHeader.test.tsx/FilesTab.test.tsx).
const { getMock, postMock, patchMock, deleteMock, toastSuccessMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
  };
});

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: vi.fn() },
}));

// Radix's Select never reaches an interactive open state under jsdom (same
// limitation StorageLocationBar.test.tsx/SettingsPage.test.tsx work around)
// -- swap it for a plain native <select>, forwarding `...rest` (which
// carries the `aria-label` `PrintsTab.tsx` puts on the `Select` root) onto
// the native element so `getByRole("combobox", { name })` can tell the
// Printer/Result selects apart.
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
    <select value={value} onChange={(event) => onValueChange(event.target.value)} {...rest}>
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
  slug: "test-model",
  name: "Test Model",
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

const SUMMARY: ModelSummary = {
  id: 1,
  slug: "test-model",
  name: "Test Model",
  description: null,
  tags: [],
  updated_at: "2026-06-01T12:00:00Z",
  created_at: "2026-06-01T12:00:00Z",
  file_count: 0,
  formats: [],
  cover: null,
  render_url: null,
  print_time_s: null,
  has_sliced: false,
  source_site: null,
  source_collection_id: null,
  source_collection_title: null,
  favorite: false,
};

const QUEUE_ENTRY: QueueEntry = {
  id: 5,
  model_id: 1,
  position: 1,
  added_at: "2026-07-01T00:00:00Z",
  model: SUMMARY,
  printable_file: null,
};

function printEntry(overrides: Partial<PrintEntry> = {}): PrintEntry {
  return {
    id: 1,
    model_id: 1,
    printed_at: "2026-07-01T10:00:00Z",
    printer_name: "Bambu X1C",
    filament: "PLA Black",
    result: "success",
    duration_min: 125,
    notes: null,
    created_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function setupGet(overrides: { prints?: PrintEntry[]; printers?: unknown[]; queue?: QueueEntry[] } = {}) {
  getMock.mockImplementation((path: string) => {
    if (path === "/models/1/prints") return Promise.resolve(overrides.prints ?? []);
    if (path === "/printers") return Promise.resolve(overrides.printers ?? []);
    if (path === "/queue") return Promise.resolve(overrides.queue ?? []);
    return Promise.resolve([]);
  });
}

function renderPrintsTab(model: ModelDetail = MODEL) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PrintsTab model={model} />
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

beforeEach(() => {
  getMock.mockReset();
  setupGet();
  postMock.mockReset().mockResolvedValue(printEntry());
  patchMock.mockReset().mockResolvedValue(printEntry());
  deleteMock.mockReset().mockResolvedValue(undefined);
  toastSuccessMock.mockClear();
});

describe("PrintsTab -- list", () => {
  it("shows an empty state when there are no logged prints", async () => {
    setupGet({ prints: [] });
    renderPrintsTab();

    expect(await screen.findByText("No prints logged yet. Log your first print above.")).toBeInTheDocument();
  });

  it("renders prints in the order the server returns them (already reverse-chronological)", async () => {
    setupGet({
      prints: [
        printEntry({ id: 2, printed_at: "2026-07-05T10:00:00Z", printer_name: "Printer B" }),
        printEntry({ id: 1, printed_at: "2026-07-01T10:00:00Z", printer_name: "Printer A" }),
      ],
    });
    renderPrintsTab();

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Printer B")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Printer A")).toBeInTheDocument();
  });

  it("shows a colored result badge, printer, filament, duration, and notes on each row", async () => {
    setupGet({ prints: [printEntry({ result: "fail", notes: "nozzle clog" })] });
    renderPrintsTab();

    // Scoped to the row: "Fail"/"Success"/"Partial" are also always present
    // as (hidden) native <option> text in the composer's Result select mock.
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Fail")).toBeInTheDocument();
    expect(within(row).getByText("Bambu X1C")).toBeInTheDocument();
    expect(within(row).getByText("PLA Black")).toBeInTheDocument();
    expect(within(row).getByText("125 min")).toBeInTheDocument();
    expect(within(row).getByText("nozzle clog")).toBeInTheDocument();
  });
});

describe("PrintsTab -- log form", () => {
  it("logs a print without touching printed_at -- omits it, defaults result to success", async () => {
    setupGet({ prints: [] });
    renderPrintsTab();

    fireEvent.click(await screen.findByRole("button", { name: "Log print" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/models/1/prints");
    expect(body).toEqual({
      printer_name: null,
      result: "success",
      filament: null,
      duration_min: null,
      notes: null,
    });
    expect(body).not.toHaveProperty("printed_at");
  });

  it("sends printed_at as an ISO string once the field is actually touched", async () => {
    setupGet({ prints: [] });
    renderPrintsTab();

    fireEvent.change(await screen.findByLabelText("Printed at"), {
      target: { value: "2026-07-04T09:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log print" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toHaveProperty("printed_at", new Date("2026-07-04T09:30").toISOString());
  });

  it("resets the composer after a successful log", async () => {
    setupGet({ prints: [] });
    renderPrintsTab();

    fireEvent.change(await screen.findByLabelText("Filament"), { target: { value: "PETG" } });
    fireEvent.click(screen.getByRole("button", { name: "Log print" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText("Filament")).toHaveValue(""));
  });
});

describe("PrintsTab -- edit", () => {
  it("edit flow only PATCHes the field(s) actually changed", async () => {
    setupGet({ prints: [printEntry({ id: 7, notes: "first try" })] });
    renderPrintsTab();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const row = screen.getByRole("listitem");
    fireEvent.change(within(row).getByLabelText("Notes"), { target: { value: "warped corner" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledExactlyOnceWith("/prints/7", { notes: "warped corner" }),
    );
  });

  it("Cancel discards the draft without calling PATCH", async () => {
    setupGet({ prints: [printEntry({ id: 7, notes: "first try" })] });
    renderPrintsTab();

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const row = screen.getByRole("listitem");
    fireEvent.change(within(row).getByLabelText("Notes"), { target: { value: "discarded" } });
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));

    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.getByText("first try")).toBeInTheDocument();
  });
});

describe("PrintsTab -- delete", () => {
  it("requires confirmation before calling the delete endpoint", async () => {
    setupGet({ prints: [printEntry({ id: 9 })] });
    renderPrintsTab();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteMock).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete this print log entry?")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledExactlyOnceWith("/prints/9"));
  });
});

describe("PrintsTab -- queue-removal offer", () => {
  it("offers to remove the model from the print queue after logging a success print while queued", async () => {
    setupGet({ prints: [], queue: [QUEUE_ENTRY] });
    const { queryClient } = renderPrintsTab();
    // `useQueue()`'s fetch is async -- wait for it to actually land in the
    // cache before submitting, otherwise the click can race ahead of it and
    // the offer's "is this model queued" check would see stale (empty) data.
    await waitFor(() => expect(queryClient.getQueryData(["queue"])).toEqual([QUEUE_ENTRY]));

    fireEvent.click(await screen.findByRole("button", { name: "Log print" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Print logged.", expect.anything()));
    const call = toastSuccessMock.mock.calls.find(([message]) => message === "Print logged.");
    const options = call?.[1] as { action?: { label: string; onClick: () => void } };
    expect(options.action?.label).toBe("Remove from queue");

    options.action?.onClick();

    await waitFor(() => expect(deleteMock).toHaveBeenCalledExactlyOnceWith("/queue/5"));
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Removed from queue"));
  });

  it("does not offer queue removal when the model isn't queued", async () => {
    setupGet({ prints: [], queue: [] });
    renderPrintsTab();

    fireEvent.click(await screen.findByRole("button", { name: "Log print" }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Print logged."));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("does not offer queue removal when the logged result isn't success", async () => {
    setupGet({ prints: [], queue: [QUEUE_ENTRY] });
    postMock.mockResolvedValue(printEntry({ result: "fail" }));
    const { queryClient } = renderPrintsTab();
    // Same race as above -- make sure the model really is queued (not just
    // "not loaded yet") before asserting the offer is withheld for the
    // *result* reason this test targets.
    await waitFor(() => expect(queryClient.getQueryData(["queue"])).toEqual([QUEUE_ENTRY]));

    fireEvent.change(await screen.findByRole("combobox", { name: "Result" }), { target: { value: "fail" } });
    fireEvent.click(screen.getByRole("button", { name: "Log print" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect((postMock.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ result: "fail" });
    expect(toastSuccessMock).toHaveBeenCalledWith("Print logged.");
  });
});
