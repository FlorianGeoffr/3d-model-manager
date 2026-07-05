import { DownloadIcon, Trash2Icon } from "lucide-react";

import { useDeleteFile } from "@/api/library";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CopyableHash } from "@/components/model-detail/CopyableHash";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, humanizeBytes } from "@/lib/format";
import type { ModelDetail } from "@/api/types";

export function FilesTab({ model }: { model: ModelDetail }) {
  const deleteFile = useDeleteFile(model.slug);
  const files = model.current_revision?.files ?? [];

  if (files.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No files on the current revision yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Path</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>Hash</TableHead>
          <TableHead>Modified</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.id}>
            <TableCell className="max-w-64 truncate font-mono text-xs" title={file.rel_path}>
              {file.rel_path}
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
        ))}
      </TableBody>
    </Table>
  );
}
