import { act, useEffect, useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UploadQueueItem, type QueueItem } from "@/components/upload/UploadQueueItem";
import type { UploadFn } from "@/api/upload";
import type { UploadResult } from "@/api/types";

/** Drives a single queue item through the real upload lifecycle
 * (pending -> uploading -> processing/failed) using an injected `uploadFn`
 * in place of the real XHR-based `uploadFile` (Task 8 decision: design the
 * uploader as `uploadFile(params, { onProgress }) => Promise` so tests can
 * fake it instead of mocking `XMLHttpRequest`). */
function UploadHarness({ uploadFn }: { uploadFn: UploadFn }) {
  const [item, setItem] = useState<QueueItem>({
    id: "1",
    file: new File(["hello"], "model.stl"),
    relPath: "model.stl",
    size: 5,
    progress: 0,
    status: "pending",
  });

  useEffect(() => {
    setItem((prev) => ({ ...prev, status: "uploading" }));
    uploadFn(
      { modelId: 1, revisionId: 1, relPath: "model.stl", file: item.file },
      { onProgress: (loaded, total) => setItem((prev) => ({ ...prev, progress: Math.round((loaded / total) * 100) })) },
    )
      .then((result) => setItem((prev) => ({ ...prev, status: "processing", progress: 100, jobId: result.job_id })))
      .catch((error: unknown) =>
        setItem((prev) => ({
          ...prev,
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed",
        })),
      );
    // Runs exactly once against the injected uploader for this harness instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <UploadQueueItem item={item} onRelPathChange={() => {}} onRemove={() => {}} />;
}

describe("UploadQueueItem", () => {
  it("shows upload progress then flips to Processing once the injected uploader resolves", async () => {
    let resolveUpload!: (result: UploadResult) => void;
    const fakeUpload: UploadFn = (_params, callbacks) => {
      callbacks?.onProgress?.(50, 100);
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    };

    render(<UploadHarness uploadFn={fakeUpload} />);

    expect(await screen.findByText("Uploading")).toBeInTheDocument();
    const progressBar = screen.getByRole("progressbar", { name: /model\.stl/i });
    expect(progressBar).toHaveAttribute("aria-valuenow", "50");

    await act(async () => {
      resolveUpload({ file_id: 1, blob_hash: "abc123", size: 5, job_id: "job-1" });
      await Promise.resolve();
    });

    expect(await screen.findByText("Processing")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /model\.stl/i })).toHaveAttribute("aria-valuenow", "100");
  });

  it("flips to Failed and shows the error when the injected uploader rejects", async () => {
    const fakeUpload: UploadFn = () => Promise.reject(new Error("network error during upload"));

    render(<UploadHarness uploadFn={fakeUpload} />);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("network error during upload")).toBeInTheDocument();
  });
});
