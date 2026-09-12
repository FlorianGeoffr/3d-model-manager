/**
 * Layer-by-layer g-code preview (R10-B, plan item 10). ``gcode-preview``
 * (a standalone WebGL/three.js library) is heavy the same way
 * three/@react-three/fiber are (Global Constraints "BUNDLE RULE") -- this
 * module must stay `React.lazy`-loaded from `PlatePanel`, behind a
 * "Preview layers" button, so it never lands in the main bundle. It does
 * NOT reuse `ModelViewer`'s R3F scene: `gcode-preview` drives its own
 * `<canvas>`/renderer directly.
 */
import { useEffect, useRef, useState } from "react";
import type { WebGLPreview } from "gcode-preview";

/** GET /api/files/{id}/download?member=gcode (R10-B) — the backend
 * extracts a `.gcode.3mf`'s embedded plate gcode; a bare `.gcode` file
 * would just stream itself, though `PlatePanel` only mounts this for
 * sliced files today. */
function gcodeDownloadUrl(fileId: number): string {
  return `/api/files/${fileId}/download?member=gcode`;
}

/** Above this, don't even try to load the gcode text into the browser
 * (review finding 1): `gcode-preview` needs the whole body as one string,
 * and a huge sliced-project plate can be hundreds of MB -- reading
 * `response.text()` on that risks hanging/crashing the tab. */
const TOO_LARGE_TO_PREVIEW_BYTES = 150 * 1024 * 1024;

export function GcodePreview({ fileId }: { fileId: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<WebGLPreview | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "too-large">("loading");
  const [layerCount, setLayerCount] = useState(0);
  const [layer, setLayer] = useState(1);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus("loading");
      try {
        const [{ init }, response] = await Promise.all([
          import("gcode-preview"),
          fetch(gcodeDownloadUrl(fileId), { credentials: "include" }),
        ]);
        if (!response.ok) throw new Error(`gcode download failed: ${response.status}`);

        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > TOO_LARGE_TO_PREVIEW_BYTES) {
          if (!cancelled) setStatus("too-large");
          return;
        }

        const text = await response.text();
        if (cancelled || !canvasRef.current) return;

        const preview = init({ canvas: canvasRef.current, buildVolume: { x: 256, y: 256, z: 256 } });
        preview.processGCode(text);
        preview.render();
        previewRef.current = preview;

        const total = preview.maxLayerIndex + 1;
        setLayerCount(total);
        setLayer(total);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, [fileId]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || status !== "ready") return;
    preview.endLayer = layer;
    preview.render();
  }, [layer, status]);

  const currentHeight = previewRef.current?.layers[layer - 1]?.height ?? null;

  if (status === "error") {
    return <p className="py-8 text-center text-sm text-muted-foreground">Couldn't load the g-code preview.</p>;
  }

  if (status === "too-large") {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Too large to preview in the browser.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      {status === "loading" ? (
        <p className="text-center text-sm text-muted-foreground">Loading preview…</p>
      ) : (
        <div className="space-y-1">
          <input
            type="range"
            className="w-full"
            min={1}
            max={Math.max(layerCount, 1)}
            step={1}
            value={layer}
            onChange={(event) => setLayer(Number(event.target.value))}
            aria-label="Layer"
          />
          <p className="text-xs text-muted-foreground">
            Layer {layer} / {layerCount}
            {currentHeight !== null ? ` · Z ${currentHeight.toFixed(2)} mm` : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export default GcodePreview;
