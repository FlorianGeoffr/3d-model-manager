import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Features, PrinterOut } from "@/api/types";
import { PrinterSetupCard } from "@/components/settings/PrinterSetupCard";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as SettingsPage.test.tsx/ScanReport.test.tsx), so the fakes
// have to be created through `vi.hoisted`.
const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, patch: patchMock, delete: deleteMock },
  };
});

const PRINTER: PrinterOut = {
  id: 1,
  name: "Bambu A1",
  kind: "bambu_lan",
  host: "192.168.1.50",
  serial: "AC12345",
  model: "A1 mini",
  enabled: true,
  options: {},
  access_code_set: true,
};

function mockApi(features: Features, printers: PrinterOut[] = []) {
  getMock.mockImplementation((path: string) => {
    if (path === "/features") return Promise.resolve(features);
    if (path === "/printers") return Promise.resolve(printers);
    return Promise.resolve([]);
  });
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PrinterSetupCard />
    </QueryClientProvider>,
  );
}

describe("PrinterSetupCard", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    patchMock.mockReset();
    deleteMock.mockReset();
  });

  it("shows the disabled note when the printer feature flag is off", async () => {
    mockApi({ printer_enabled: false });

    renderCard();

    expect(await screen.findByText(/Printer integration is disabled/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Name/)).not.toBeInTheDocument();
  });

  it("omits a blank access_code from the create request body", async () => {
    mockApi({ printer_enabled: true }, []);
    postMock.mockResolvedValue({ ...PRINTER, id: 2 });

    renderCard();

    await screen.findByText("Add a printer");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Printer" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "192.168.1.99" } });
    fireEvent.change(screen.getByLabelText("Serial"), { target: { value: "SN999" } });

    fireEvent.click(screen.getByRole("button", { name: "Add printer" }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ name: "New Printer", host: "192.168.1.99", serial: "SN999", access_code: "" });
  });

  it("omits access_code from the PATCH body when the field is left blank", async () => {
    mockApi({ printer_enabled: true }, [PRINTER]);
    patchMock.mockResolvedValue({ ...PRINTER, name: "Renamed" });

    renderCard();

    await screen.findByDisplayValue("Bambu A1");
    fireEvent.change(screen.getByDisplayValue("Bambu A1"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const [, body] = patchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("access_code");
    expect(body.name).toBe("Renamed");
  });

  it("sends access_code in the PATCH body once the user types a new value", async () => {
    mockApi({ printer_enabled: true }, [PRINTER]);
    patchMock.mockResolvedValue(PRINTER);

    renderCard();

    await screen.findByDisplayValue("Bambu A1");
    // Both the existing printer's editor and the "Add a printer" form below
    // it have an "Access code" field -- the existing printer's is first.
    fireEvent.change(screen.getAllByLabelText("Access code")[0], { target: { value: "new-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    const [, body] = patchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.access_code).toBe("new-code");
  });

  it("Test connection surfaces ProbeOut.detail", async () => {
    mockApi({ printer_enabled: true }, [PRINTER]);
    postMock.mockResolvedValue({ ok: true, detail: "connected via LAN", gcode_state: "IDLE" });

    renderCard();

    await screen.findByDisplayValue("Bambu A1");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/connected via LAN/)).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledWith("/printers/1/test");
  });
});
