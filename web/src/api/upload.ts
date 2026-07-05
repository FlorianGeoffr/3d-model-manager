/**
 * `XMLHttpRequest`-based upload PUT (fetch has no upload progress events —
 * Task 8 decision). Exposed as a plain function with an injectable
 * `{ onProgress }` callback so tests can fake the uploader instead of
 * mocking the global `XMLHttpRequest`.
 */
import type { UploadResult } from "@/api/types";

export interface UploadParams {
  modelId: number;
  revisionId: number;
  relPath: string;
  file: Blob;
  replace?: boolean;
}

export interface UploadCallbacks {
  onProgress?: (loaded: number, total: number) => void;
}

export type UploadFn = (params: UploadParams, callbacks?: UploadCallbacks) => Promise<UploadResult>;

function extractErrorDetail(xhr: XMLHttpRequest): string | null {
  try {
    const data: unknown = JSON.parse(xhr.responseText);
    if (data !== null && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string") {
      return (data as { detail: string }).detail;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

export const uploadFile: UploadFn = (params, callbacks = {}) => {
  return new Promise((resolve, reject) => {
    const searchParams = new URLSearchParams({
      model_id: String(params.modelId),
      revision_id: String(params.revisionId),
      rel_path: params.relPath,
    });
    if (params.replace) searchParams.set("replace", "true");

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/uploads?${searchParams.toString()}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        callbacks.onProgress?.(event.loaded, event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error("invalid upload response"));
        }
      } else {
        reject(new Error(extractErrorDetail(xhr) ?? `upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.send(params.file);
  });
};
