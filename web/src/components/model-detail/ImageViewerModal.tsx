import { useEffect, useState, useCallback, useMemo } from "react";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { humanizeBytes } from "@/lib/format";
import type { FileOut } from "@/api/types";

export function isImageFile(file: FileOut): boolean {
  if (file.kind === "image") return true;
  const fmt = file.format?.toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(fmt)) return true;
  const lower = file.rel_path?.toLowerCase() ?? "";
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].some((ext) => lower.endsWith(ext));
}

interface ImageViewerModalProps {
  files: FileOut[];
  initialFile: FileOut | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageViewerModal({
  files,
  initialFile,
  open,
  onOpenChange,
}: ImageViewerModalProps) {
  const imageFiles = useMemo(() => files.filter(isImageFile), [files]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);

  // Sync initial index when opened with a specific file
  useEffect(() => {
    if (initialFile) {
      const idx = imageFiles.findIndex((f) => f.id === initialFile.id || f.blob_hash === initialFile.blob_hash);
      if (idx !== -1) {
        setCurrentIndex(idx);
      }
    }
    setZoomLevel(1);
  }, [initialFile, open, imageFiles]);

  const currentFile = imageFiles[currentIndex] ?? null;

  const handlePrev = useCallback(() => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : imageFiles.length - 1));
    setZoomLevel(1);
  }, [imageFiles.length]);

  const handleNext = useCallback(() => {
    setCurrentIndex((prev) => (prev < imageFiles.length - 1 ? prev + 1 : 0));
    setZoomLevel(1);
  }, [imageFiles.length]);

  const toggleZoom = useCallback(() => {
    setZoomLevel((prev) => (prev === 1 ? 2 : 1));
  }, []);

  // Keyboard navigation: Left/Right arrows, Escape
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "Escape") {
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, handlePrev, handleNext, onOpenChange]);

  if (!open || !currentFile) return null;

  const filename = currentFile.rel_path.split("/").pop() ?? currentFile.rel_path;
  // Use inline download url to get original resolution or fallback to high-res blob thumb
  const imageUrl = `/api/files/${currentFile.id}/download?inline=1`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm" />
        <DialogContent
          showCloseButton={false}
          className="fixed inset-0 z-50 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col border-none bg-transparent p-0 text-white shadow-none ring-0 focus:outline-none"
        >
          {/* Top header toolbar */}
          <div className="flex h-14 shrink-0 items-center justify-between bg-black/60 px-4 backdrop-blur-md">
            <div className="flex items-center gap-3 overflow-hidden text-sm">
              <span className="truncate font-medium">{filename}</span>
              <span className="text-xs text-neutral-400">({humanizeBytes(currentFile.size)})</span>
              {imageFiles.length > 1 && (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                  {currentIndex + 1} / {imageFiles.length}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-neutral-300 hover:bg-white/10 hover:text-white"
                onClick={toggleZoom}
                title={zoomLevel === 1 ? "Zoom in" : "Zoom out"}
              >
                {zoomLevel === 1 ? <ZoomInIcon className="size-4" /> : <ZoomOutIcon className="size-4" />}
                <span className="sr-only">Toggle zoom</span>
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                className="text-neutral-300 hover:bg-white/10 hover:text-white"
                asChild
              >
                <a href={`/api/files/${currentFile.id}/download`} download={filename} title="Download image">
                  <DownloadIcon className="size-4" />
                  <span className="sr-only">Download</span>
                </a>
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                className="text-neutral-300 hover:bg-white/10 hover:text-white"
                onClick={() => onOpenChange(false)}
                title="Close (Esc)"
              >
                <XIcon className="size-5" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>

          {/* Main content viewport */}
          <div className="relative flex flex-1 items-center justify-center overflow-auto p-4 select-none">
            {imageFiles.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handlePrev}
                className="absolute left-4 z-10 size-11 rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/80"
                aria-label="Previous photo"
              >
                <ChevronLeftIcon className="size-6" />
              </Button>
            )}

            <div
              className="flex max-h-full max-w-full items-center justify-center transition-transform duration-200"
              style={{ transform: `scale(${zoomLevel})` }}
              onClick={toggleZoom}
            >
              <img
                src={imageUrl}
                alt={filename}
                className={`max-h-[calc(100vh-10rem)] max-w-[calc(100vw-6rem)] object-contain select-none cursor-${zoomLevel === 1 ? "zoom-in" : "zoom-out"}`}
                draggable={false}
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  const thumbFallback = `/api/blobs/${currentFile.blob_hash}/thumb?size=1024`;
                  if (target.src !== thumbFallback) {
                    target.src = thumbFallback;
                  }
                }}
              />
            </div>

            {imageFiles.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleNext}
                className="absolute right-4 z-10 size-11 rounded-full bg-black/50 text-white backdrop-blur hover:bg-black/80"
                aria-label="Next photo"
              >
                <ChevronRightIcon className="size-6" />
              </Button>
            )}
          </div>

          {/* Bottom thumbnail miniature strip */}
          {imageFiles.length > 1 && (
            <div className="flex h-20 shrink-0 items-center justify-center gap-2 overflow-x-auto bg-black/70 px-4 py-2 backdrop-blur-md">
              {imageFiles.map((file, idx) => {
                const isActive = idx === currentIndex;
                const thumbSrc = `/api/blobs/${file.blob_hash}/thumb?size=256`;
                const inlineSrc = `/api/files/${file.id}/download?inline=1`;
                return (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => {
                      setCurrentIndex(idx);
                      setZoomLevel(1);
                    }}
                    className={cn(
                      "relative size-14 shrink-0 overflow-hidden rounded-md border-2 transition-all hover:opacity-100",
                      isActive
                        ? "border-primary ring-2 ring-primary/50 opacity-100 scale-105"
                        : "border-transparent opacity-60 hover:border-white/40",
                    )}
                    title={file.rel_path}
                  >
                    <img
                      src={thumbSrc}
                      alt={file.rel_path}
                      loading="lazy"
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = inlineSrc;
                      }}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
