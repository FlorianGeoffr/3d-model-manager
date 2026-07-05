/**
 * Resolve dropped `DataTransferItem`s to `{ file, relPath }` pairs,
 * preserving subdirectory structure when the browser exposes the (legacy
 * but widely-supported) File and Directory Entries API via
 * `webkitGetAsEntry` — falls back to flat filenames otherwise (Task 8:
 * "subdirs preserved when dropping folders if trivially supported").
 */

export interface DroppedFile {
  file: File;
  relPath: string;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    out.push({ file, relPath: `${prefix}${entry.name}` });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllEntries(reader);
    for (const child of children) {
      await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Resolve a drop event's items to files with relative paths. */
export async function resolveDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    // No Entries API support (or a non-file drag) — fall back to the flat
    // FileList, which is always available.
    return Array.from(dataTransfer.files).map((file) => ({ file, relPath: file.name }));
  }

  const out: DroppedFile[] = [];
  for (const entry of entries) {
    await walk(entry, "", out);
  }
  return out;
}
