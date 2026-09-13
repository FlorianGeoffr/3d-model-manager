/**
 * Docs tab (R13c): the same table shape as `FilesTab.tsx` but scoped to
 * `kind === "doc"` files, with a doc-specific expandable preview per row
 * instead of a mesh/sliced meta line -- pdf renders inline via `<iframe>`,
 * md/txt fetch their raw text and render it (markdown vs. plain `<pre>`),
 * docx (and anything else doc-kind) has no inline preview at all, just the
 * shared `FileActionsMenu` for Download.
 *
 * Preview is a per-row toggle (not always-on) so opening this tab doesn't
 * fire an md/txt fetch for every doc up front -- docs tend to be few per
 * model, but there's no reason to pay for previews nobody opens.
 */
import { Fragment, useEffect, useState } from "react";
import { FileText as FileTextIcon } from "lucide-react";

import { FileActionsMenu } from "@/components/model-detail/FileActionsMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, humanizeBytes } from "@/lib/format";
import { formatIcon } from "@/lib/formatMeta";
import { MARKDOWN_CLASSNAME, renderMarkdown } from "@/lib/markdown";
import type { FileOut, ModelDetail } from "@/api/types";

function inlineDownloadUrl(file: FileOut): string {
  return `/api/files/${file.id}/download?inline=1`;
}

function DocThumb({ file }: { file: FileOut }) {
  const Icon = formatIcon(file.format);
  return (
    <div className="flex size-10 items-center justify-center rounded bg-muted text-muted-foreground">
      <Icon className="size-5" />
    </div>
  );
}

/** Fetches and renders the raw text body of an md/txt doc once its row's
 * preview is toggled open. */
function TextDocPreview({ file }: { file: FileOut }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch(inlineDownloadUrl(file), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setText(body);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (error || text === null) return <p className="text-xs text-muted-foreground">Could not load this file.</p>;
  if (file.format === "md") {
    return <div className={MARKDOWN_CLASSNAME} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  }
  return <pre className="whitespace-pre-wrap text-xs">{text}</pre>;
}

function DocPreview({ file }: { file: FileOut }) {
  if (file.format === "pdf") {
    return <iframe src={inlineDownloadUrl(file)} title={file.rel_path} className="h-[600px] w-full rounded border" />;
  }
  if (file.format === "md" || file.format === "txt") {
    return <TextDocPreview file={file} />;
  }
  return null;
}

function isPreviewable(file: FileOut): boolean {
  return file.format === "pdf" || file.format === "md" || file.format === "txt";
}

export function DocsTab({ model }: { model: ModelDetail }) {
  const [openPreviewId, setOpenPreviewId] = useState<number | null>(null);
  const files = (model.current_revision?.files ?? []).filter((file) => file.kind === "doc");

  if (files.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No documents on the current revision yet.</p>;
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">
              <span className="sr-only">Thumbnail</span>
            </TableHead>
            <TableHead>Path</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Modified</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const previewable = isPreviewable(file);
            const previewOpen = openPreviewId === file.id;
            return (
              <Fragment key={file.id}>
                <TableRow>
                  <TableCell>
                    <DocThumb file={file} />
                  </TableCell>
                  <TableCell className="max-w-[28rem] font-mono text-xs 2xl:max-w-none">
                    <div className="truncate" title={file.rel_path}>
                      {file.rel_path}
                    </div>
                  </TableCell>
                  <TableCell>{humanizeBytes(file.size)}</TableCell>
                  <TableCell>{formatDateTime(file.mtime)}</TableCell>
                  <TableCell>
                    <Badge variant={file.verified_at ? "secondary" : "outline"}>
                      {file.verified_at ? "stored" : "processing"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {previewable ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setOpenPreviewId(previewOpen ? null : file.id)}
                        >
                          <FileTextIcon className="size-4" />
                          {previewOpen ? "Hide preview" : "Preview"}
                        </Button>
                      ) : null}
                      <FileActionsMenu file={file} model={model} isDoc />
                    </div>
                  </TableCell>
                </TableRow>
                {previewOpen ? (
                  <TableRow>
                    <TableCell colSpan={6} data-testid={`doc-preview-${file.id}`}>
                      <DocPreview file={file} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
