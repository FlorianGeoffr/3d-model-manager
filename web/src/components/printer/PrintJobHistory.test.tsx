import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PrintJobHistory } from "@/components/printer/PrintJobHistory";
import type { PrintJobOut } from "@/api/types";

const mockUsePrintJobs = vi.fn();
vi.mock("@/api/printers", () => ({
  usePrintJobs: () => mockUsePrintJobs(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: any) => (
    <a href={to} data-slug={params?.slug} className={className}>
      {children}
    </a>
  ),
}));

describe("PrintJobHistory", () => {
  it("renders empty state when no jobs exist", () => {
    mockUsePrintJobs.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [],
    });

    render(<PrintJobHistory />);
    expect(screen.getByText("No print jobs yet.")).toBeInTheDocument();
  });

  it("renders print jobs with photo, duration, filament material and weight", () => {
    const job: PrintJobOut = {
      id: 42,
      printer_id: 1,
      file_id: 10,
      subtask_name: "benchy_plate_1.gcode.3mf",
      state: "finished",
      progress_pct: 100,
      remaining_min: 0,
      layer: 120,
      total_layers: 120,
      printer_error: null,
      created_at: "2026-09-30T10:00:00Z",
      started_at: "2026-09-30T10:05:00Z",
      finished_at: "2026-09-30T11:45:00Z",
      model_slug: "3d-benchy",
      model_name: "3D Benchy",
      snapshot_url: "/api/blobs/snap123/thumb?size=256",
      thumbnail_url: "/api/blobs/thumb123/thumb?size=256",
      duration_s: 6000, // 1h 40m
      filament_g: 45.2,
      filament_m: 14.5,
      filament_types: ["PLA", "Silk PLA"],
    };

    mockUsePrintJobs.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [job],
    });

    render(<PrintJobHistory />);

    expect(screen.getByText("3D Benchy")).toBeInTheDocument();
    expect(screen.getByText("finished")).toBeInTheDocument();
    expect(screen.getByText("1h 40m")).toBeInTheDocument();
    expect(screen.getByText(/45 g/)).toBeInTheDocument();
    expect(screen.getByText("PLA")).toBeInTheDocument();
    expect(screen.getByText("Silk PLA")).toBeInTheDocument();
  });

  it("renders external print jobs without associated file or model cleanly", () => {
    const job: PrintJobOut = {
      id: 99,
      printer_id: 1,
      file_id: null,
      subtask_name: "External_Case_plate_1.gcode.3mf",
      state: "printing",
      progress_pct: 42,
      remaining_min: 30,
      layer: 50,
      total_layers: 120,
      printer_error: null,
      created_at: "2026-10-03T12:00:00Z",
      started_at: "2026-10-03T12:05:00Z",
      finished_at: null,
      model_slug: null,
      model_name: null,
    };

    mockUsePrintJobs.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [job],
    });

    render(<PrintJobHistory />);

    expect(screen.getByText("External_Case_plate_1.gcode.3mf")).toBeInTheDocument();
    expect(screen.getByText("External print")).toBeInTheDocument();
    expect(screen.getByText("printing")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});
