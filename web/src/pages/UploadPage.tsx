import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { UploadCloudIcon } from "lucide-react";

import { useCreateModel } from "@/api/library";
import { uploadFile } from "@/api/upload";
import { TargetPicker, type ExistingTarget, type TargetMode } from "@/components/upload/TargetPicker";
import { UploadQueueItem, type QueueItem } from "@/components/upload/UploadQueueItem";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveDroppedFiles, type DroppedFile } from "@/lib/droppedFiles";
import { useEvents } from "@/hooks/useEvents";
import type { ModelDetail } from "@/api/types";

interface ResolvedTarget {
  modelId: number;
  revisionId: number;
  slug: string;
  name: string;
}

function toQueueItems(files: DroppedFile[]): QueueItem[] {
  return files.map((entry) => ({
    id: crypto.randomUUID(),
    file: entry.file,
    relPath: entry.relPath,
    size: entry.file.size,
    progress: 0,
    status: "pending",
  }));
}

export function UploadPage() {
  const [mode, setMode] = useState<TargetMode>("new");
  const [newModelName, setNewModelName] = useState("");
  const [existingTarget, setExistingTarget] = useState<ExistingTarget | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [resolvedTarget, setResolvedTarget] = useState<ResolvedTarget | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const createModel = useCreateModel();
  const queryClient = useQueryClient();
  const events = useEvents();

  useEffect(() => {
    return events.subscribe((event) => {
      setQueue((prev) =>
        prev.map((item) => {
          if (item.jobId !== event.job_id) return item;
          if (event.state === "done") return { ...item, status: "stored" };
          if (event.state === "failed") return { ...item, status: "failed", error: "Processing failed" };
          return item;
        }),
      );
    });
  }, [events]);

  function addFiles(files: DroppedFile[]) {
    if (files.length === 0) return;
    setQueue((prev) => [...prev, ...toQueueItems(files)]);
  }

  function updateItem(id: string, patch: Partial<QueueItem>) {
    setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function removeItem(id: string) {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }

  function handleNewModelNameChange(name: string) {
    setNewModelName(name);
    // The name the user is now typing no longer describes whatever model a
    // previous batch resolved/created -- editing it after that point must
    // start a fresh model on the next upload, not silently keep appending
    // to the old one.
    setResolvedTarget(null);
  }

  function handleExistingTargetChange(target: ExistingTarget | null) {
    setExistingTarget(target);
    // Same rule as editing the new-model name: picking a different existing
    // model must invalidate whatever target a previous batch resolved, or
    // the next batch silently uploads to the stale one.
    setResolvedTarget(null);
  }

  function handleFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).map((file) => ({
      file,
      relPath: file.webkitRelativePath || file.name,
    }));
    addFiles(files);
    event.target.value = "";
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const files = await resolveDroppedFiles(event.dataTransfer);
    addFiles(files);
  }

  const targetReady = mode === "new" ? newModelName.trim().length > 0 : existingTarget !== null;
  const pendingCount = queue.filter((item) => item.status === "pending").length;

  async function handleStartUpload() {
    // Reuse the target resolved by a previous batch instead of re-resolving
    // it: in "new" mode that previously meant calling `createModel` again on
    // every subsequent batch, silently creating "name-2", "name-3", ...
    // instead of adding more files to the model the first batch created.
    let target = resolvedTarget;
    if (!target) {
      if (mode === "new") {
        let model: ModelDetail;
        try {
          model = await createModel.mutateAsync({ name: newModelName.trim() });
        } catch {
          // Global MutationCache.onError toast already surfaced the failure.
          return;
        }
        if (!model.current_revision) return;
        target = { modelId: model.id, revisionId: model.current_revision.id, slug: model.slug, name: model.name };
      } else {
        if (!existingTarget) return;
        target = existingTarget;
      }
      setResolvedTarget(target);
    }
    setIsUploading(true);

    for (const item of queue) {
      if (item.status !== "pending") continue;
      updateItem(item.id, { status: "uploading", progress: 0 });
      try {
        const result = await uploadFile(
          { modelId: target.modelId, revisionId: target.revisionId, relPath: item.relPath, file: item.file },
          {
            onProgress: (loaded, total) =>
              updateItem(item.id, { progress: total > 0 ? Math.round((loaded / total) * 100) : 0 }),
          },
        );
        updateItem(item.id, { status: "processing", progress: 100, jobId: result.job_id });
      } catch (error) {
        updateItem(item.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Upload failed",
        });
      }
    }

    setIsUploading(false);
    void queryClient.invalidateQueries({ queryKey: ["models"] });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload files</CardTitle>
          <CardDescription>Choose a target model, then add files to the queue.</CardDescription>
        </CardHeader>
        <CardContent>
          <TargetPicker
            mode={mode}
            onModeChange={(next) => {
              setMode(next);
              setResolvedTarget(null);
            }}
            newModelName={newModelName}
            onNewModelNameChange={handleNewModelNameChange}
            existingTarget={existingTarget}
            onExistingTargetChange={handleExistingTargetChange}
            disabled={isUploading}
          />
        </CardContent>
      </Card>

      {resolvedTarget ? (
        <p className="text-sm text-muted-foreground">
          Uploading to{" "}
          <Link to="/models/$slug" params={{ slug: resolvedTarget.slug }} className="font-medium underline">
            {resolvedTarget.name}
          </Link>
        </p>
      ) : null}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => void handleDrop(event)}
        className={`flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragActive ? "border-primary bg-primary/5" : "border-border"
        }`}
      >
        <UploadCloudIcon className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Drag and drop files or folders here</p>
        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
          Browse files
        </Button>
        <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInputChange} />
      </div>

      {queue.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Queue ({queue.length})</h3>
            <Button
              type="button"
              onClick={() => void handleStartUpload()}
              disabled={!targetReady || isUploading || pendingCount === 0}
            >
              {isUploading ? "Uploading..." : `Upload ${pendingCount || ""}`.trim()}
            </Button>
          </div>
          <div className="space-y-2">
            {queue.map((item) => (
              <UploadQueueItem
                key={item.id}
                item={item}
                onRelPathChange={(relPath) => updateItem(item.id, { relPath })}
                onRemove={() => removeItem(item.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
