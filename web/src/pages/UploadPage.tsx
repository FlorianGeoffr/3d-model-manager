import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useCreateModel } from "@/api/library";
import { TargetPicker, type ExistingTarget, type TargetMode } from "@/components/upload/TargetPicker";
import { UploadDropzone, type UploadTarget } from "@/components/upload/UploadDropzone";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ModelDetail } from "@/api/types";

interface ResolvedTarget {
  modelId: number;
  revisionId: number;
  slug: string;
  name: string;
}

// Re-exported so existing tests (`import { TerminalEventMap } from
// "@/pages/UploadPage"`) keep working unmodified after Task 10 moved the
// class itself into UploadDropzone.tsx along with the rest of the queue/SSE
// machinery it belongs to.
export { TerminalEventMap } from "@/components/upload/UploadDropzone";

export function UploadPage() {
  const [mode, setMode] = useState<TargetMode>("new");
  const [newModelName, setNewModelName] = useState("");
  const [existingTarget, setExistingTarget] = useState<ExistingTarget | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState<ResolvedTarget | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const createModel = useCreateModel();
  const queryClient = useQueryClient();

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

  const targetReady = mode === "new" ? newModelName.trim().length > 0 : existingTarget !== null;

  // Reuse the target resolved by a previous batch instead of re-resolving
  // it: in "new" mode that previously meant calling `createModel` again on
  // every subsequent batch, silently creating "name-2", "name-3", ...
  // instead of adding more files to the model the first batch created.
  async function resolveTarget(): Promise<UploadTarget | null> {
    let target = resolvedTarget;
    if (!target) {
      if (mode === "new") {
        let model: ModelDetail;
        try {
          model = await createModel.mutateAsync({ name: newModelName.trim() });
        } catch {
          // Global MutationCache.onError toast already surfaced the failure.
          return null;
        }
        if (!model.current_revision) return null;
        target = { modelId: model.id, revisionId: model.current_revision.id, slug: model.slug, name: model.name };
      } else {
        if (!existingTarget) return null;
        target = existingTarget;
      }
      setResolvedTarget(target);
    }
    return target;
  }

  function handleUploadComplete() {
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

      <UploadDropzone
        resolveTarget={resolveTarget}
        disabled={!targetReady}
        onUploadingChange={setIsUploading}
        onUploadComplete={handleUploadComplete}
      />
    </div>
  );
}
