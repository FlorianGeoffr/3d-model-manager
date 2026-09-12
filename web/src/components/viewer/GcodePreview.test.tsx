import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GcodePreview } from "@/components/viewer/GcodePreview";

const processGCode = vi.fn();
const renderSpy = vi.fn();
const dispose = vi.fn();

const fakePreview = {
  processGCode,
  render: renderSpy,
  dispose,
  maxLayerIndex: 2,
  endLayer: undefined as number | undefined,
  layers: [{ height: 0.2 }, { height: 0.4 }, { height: 0.6 }],
};

vi.mock("gcode-preview", () => ({
  init: vi.fn(() => fakePreview),
}));

describe("GcodePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve("G1 X0 Y0\n") } as Response),
    ) as unknown as typeof fetch;
  });

  it("fetches the file's embedded gcode via the member=gcode download param", async () => {
    render(<GcodePreview fileId={42} />);

    await waitFor(() => expect(processGCode).toHaveBeenCalledWith("G1 X0 Y0\n"));

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/files/42/download?member=gcode",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("shows the layer readout once loaded", async () => {
    render(<GcodePreview fileId={42} />);

    await waitFor(() => expect(screen.getByText(/Layer 3 \/ 3/)).toBeInTheDocument());
  });

  it("shows an error state when the fetch fails", async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)) as unknown as typeof fetch;

    render(<GcodePreview fileId={42} />);

    await waitFor(() =>
      expect(screen.getByText(/couldn't load the g-code preview/i)).toBeInTheDocument(),
    );
  });
});
