import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, EyeIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { modelQueryOptions, useDeleteFile } from "@/api/library";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyableHash } from "@/components/model-detail/CopyableHash";
import { OpenInSlicerButton } from "@/components/model-detail/OpenInSlicerButton";
import { SendToPrinterButton } from "@/components/model-detail/SendToPrinterButton";
import { UploadDropzone, type UploadTarget } from "@/components/upload/UploadDropzone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, humanizeBytes, humanizeDuration } from "@/lib/format";
import { formatIcon } from "@/lib/formatMeta";
import { isSlicerEligible } from "@/lib/slicers";
import { isStudioViewable } from "@/components/viewer/viewable";
import type { BlobMetaOut, FileOut, ModelDetail } from "@/api/types";

/** `{triangle_count} tris · {dims_mm joined ×} mm · {volume_cm3} cm³`, skipping
 * any part whose source value is null (Task 9 brief). */
function meshMetaLine(meta: BlobMetaOut): string | null {
  const parts: string[] = [];
  if (meta.triangle_count !== null) parts.push(`${meta.triangle_count} tris`);
  if (meta.dims_mm !== null) parts.push(`${meta.dims_mm.map((d) => d.toFixed(1)).join(" × ")} mm`);
  if (meta.volume_cm3 !== null) parts.push(`${meta.volume_cm3.toFixed(1)} cm³`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `{plate_count} plates · {humanizeDuration(print_time_s)} · {filament_g} g`,
 * skipping any part whose source value is null (Task 9 brief). */
function slicedMetaLine(meta: BlobMetaOut): string | null {
  const parts: string[] = [];
  if (meta.plate_count !== null) parts.push(`${meta.plate_count} plates`);
  if (meta.print_time_s !== null) parts.push(humanizeDuration(meta.print_time_s));
  if (meta.filament_g !== null) parts.push(`${Math.round(meta.filament_g)} g`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function fileMetaLine(file: FileOut): string | null {
  if (!file.meta) return null;
  if (file.kind === "mesh" || file.kind === "cad") return meshMetaLine(file.meta);
  if (file.kind === "sliced") return slicedMetaLine(file.meta);
  return null;
}

function FileThumb({ file }: { file: FileOut }) {
  const [errored, setErrored] = useState(false);
  const Icon = formatIcon(file.format);

  if (file.thumb_ready && !errored) {
    return (
      <img
        src={`/api/blobs/${file.blob_hash}/thumb?size=256`}
        alt={file.rel_path}
        loading="lazy"
        className="size-10 rounded object-cover"
        onError={() => setErrored(true)}
      />
    );
  }

  return (
    <div className="flex size-10 items-center justify-center rounded bg-muted text-muted-foreground">
      <Icon className="size-5" />
    </div>
  );
}

export function FilesTab({
  model,
  onViewIn3D,
}: {
  model: ModelDetail;
  /** R13c "View in 3D" hand-off: jumps the studio surface above to this
   * file (or the combined assembly, for a ready-glb file) -- the only way
   * to reach a non-glb file (CAD pending, conversion failed, plain gcode,
   * sliced) once the model also has GLB parts, since those crowd out the
   * old per-file rail. Optional so this tab still renders standalone (e.g.
   * a future window/embed) without a studio to hand off to. */
  onViewIn3D?: (file: FileOut) => void;
}) {
  const deleteFile = useDeleteFile(model.slug);
  const queryClient = useQueryClient();
  const [showAddFiles, setShowAddFiles] = useState(false);
  const files = model.current_revision?.files ?? [];
  const currentRevision = model.current_revision;

  // Uploads (Task 10, correctness map §B4) always target the model's
  // CURRENT revision through the existing `PUT /api/uploads` seam -- never
  // `create_revision` (a costly full snapshot-copy that 409s mid-upload).
  // Guarded on `currentRevision` truthiness the same way UploadPage.tsx
  // guards its own (freshly-created) target before using it.
  async function resolveTarget(): Promise<UploadTarget | null> {
    if (!currentRevision) return null;
    return { modelId: model.id, revisionId: currentRevision.id };
  }

  function handleUploadComplete() {
    // The gallery-only `["models"]` key (what UploadPage.tsx invalidates)
    // wouldn't refresh THIS already-open detail page -- invalidate the
    // specific model-detail query instead (correctness map §6).
    void queryClient.invalidateQueries({ queryKey: modelQueryOptions(model.slug).queryKey });
  }

  return (
    <TooltipProvider>
    <div className="space-y-4">
      {currentRevision ? (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setShowAddFiles((prev) => !prev)}>
            <PlusIcon className="size-4" />
            Add files
          </Button>
        </div>
      ) : null}

      {showAddFiles && currentRevision ? (
        <UploadDropzone resolveTarget={resolveTarget} onUploadComplete={handleUploadComplete} />
      ) : null}

      {files.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No files on the current revision yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">
                <span className="sr-only">Thumbnail</span>
              </TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Hash</TableHead>
              <TableHead>Modified</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((file) => {
              const metaLine = fileMetaLine(file);
              return (
                <TableRow key={file.id}>
                  <TableCell>
                    <FileThumb file={file} />
                  </TableCell>
                  <TableCell className="max-w-[28rem] font-mono text-xs 2xl:max-w-none">
                    <div className="truncate" title={file.rel_path}>
                      {file.rel_path}
                    </div>
                    {metaLine ? (
                      <div
                        className="truncate font-sans text-[11px] font-normal text-muted-foreground"
                        title={metaLine}
                      >
                        {metaLine}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{humanizeBytes(file.size)}</TableCell>
                  <TableCell>
                    <CopyableHash hash={file.blob_hash} />
                  </TableCell>
                  <TableCell>{formatDateTime(file.mtime)}</TableCell>
                  <TableCell>
                    <Badge variant={file.verified_at ? "secondary" : "outline"}>
                      {file.verified_at ? "stored" : "processing"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {onViewIn3D && isStudioViewable(file) ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`View ${file.rel_path} in 3D`}
                              onClick={() => onViewIn3D(file)}
                            >
                              <EyeIcon className="size-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>View in 3D</TooltipContent>
                        </Tooltip>
                      ) : null}
                      <SendToPrinterButton file={file} />
                      {file.verified_at && isSlicerEligible(file) ? <OpenInSlicerButton file={file} /> : null}
                      {file.verified_at ? (
                        <Button asChild variant="ghost" size="icon-sm" aria-label={`Download ${file.rel_path}`}>
                          <a href={`/api/files/${file.id}/download`}>
                            <DownloadIcon className="size-4" />
                          </a>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled
                          aria-label={`Download ${file.rel_path}`}
                          title="Still processing — download will be available once verified"
                        >
                          <DownloadIcon className="size-4" />
                        </Button>
                      )}
                      <ConfirmDialog
                        trigger={
                          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${file.rel_path}`}>
                            <Trash2Icon className="size-4" />
                          </Button>
                        }
                        title={`Delete ${file.rel_path}?`}
                        description="This removes the file from the current revision."
                        confirmLabel="Delete"
                        destructive
                        onConfirm={() => deleteFile.mutate(file.id)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
    </TooltipProvider>
  );
}
