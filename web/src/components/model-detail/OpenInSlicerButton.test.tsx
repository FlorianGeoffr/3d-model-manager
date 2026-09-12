import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileOut } from "@/api/types";
import { OpenInSlicerButton } from "@/components/model-detail/OpenInSlicerButton";
import { LAST_SLICER_STORAGE_KEY, SLICER_OPTIONS } from "@/lib/slicers";

const { postMock, toastMock, assignMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  toastMock: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  assignMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: { ...actual.api, post: postMock } };
});

vi.mock("sonner", () => ({ toast: toastMock }));

const FILE: FileOut = {
  id: 9,
  revision_id: 1,
  rel_path: "part.stl",
  storage_path: "/data/part.stl",
  blob_hash: "abc123",
  size: 2048,
  format: "stl",
  kind: "mesh",
  mtime: "2026-06-01T12:00:00Z",
  verified_at: "2026-06-01T12:00:05Z",
  meta: null,
  thumb_ready: false,
  glb_status: null,
  glb_preview_ready: false,
};

describe("OpenInSlicerButton", () => {
  beforeEach(() => {
    postMock.mockReset();
    toastMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    assignMock.mockReset();
    localStorage.clear();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignMock },
      writable: true,
    });
  });

  it("lists all 4 slicers in the dropdown", async () => {
    render(<OpenInSlicerButton file={FILE} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose slicer" }), { button: 0 });

    for (const slicer of SLICER_OPTIONS) {
      expect(await screen.findByRole("menuitem", { name: slicer.label })).toBeInTheDocument();
    }
  });

  it("posts for a slicer-link and assigns the scheme URL on click", async () => {
    postMock.mockResolvedValue({ url: "http://test/api/files/9/download?token=abc", expires_at: "later" });

    render(<OpenInSlicerButton file={FILE} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose slicer" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "PrusaSlicer" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/files/9/slicer-link"));
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "prusaslicer://open?file=" + encodeURIComponent("http://test/api/files/9/download?token=abc"),
      ),
    );
  });

  it("remembers the last-chosen slicer as the primary action", async () => {
    postMock.mockResolvedValue({ url: "http://test/api/files/9/download?token=abc", expires_at: "later" });

    render(<OpenInSlicerButton file={FILE} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose slicer" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Bambu Studio" }));

    await waitFor(() => expect(localStorage.getItem(LAST_SLICER_STORAGE_KEY)).toBe("bambustudio"));

    postMock.mockClear();
    assignMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: `Open ${FILE.rel_path} in Bambu Studio` }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/files/9/slicer-link"));
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "bambustudio://open?file=" + encodeURIComponent("http://test/api/files/9/download?token=abc"),
      ),
    );
  });
});
