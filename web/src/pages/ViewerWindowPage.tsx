import { useParams, useSearch } from "@tanstack/react-router";

import { useModel } from "@/api/library";
import type { BackgroundPreset } from "@/components/viewer/background";
import type { LightingPreset } from "@/components/viewer/lighting";
import { decodePartColors } from "@/components/viewer/partColors";
import { ViewerStage } from "@/components/viewer/ViewerStage";
import { useViewerScene } from "@/components/viewer/useViewerScene";
import { glbFiles } from "@/components/viewer/viewable";
import { Skeleton } from "@/components/ui/skeleton";
import type { FileOut } from "@/api/types";

interface WindowSearch {
  ids?: string;
  bg?: string;
  bgc?: string;
  light?: string;
  colors?: string;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-svh w-svw place-items-center bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function parseIds(ids: string | undefined): Set<number> {
  return new Set(
    (ids ?? "")
      .split(",")
      .filter((segment) => segment !== "") // Number("") is 0, not NaN -- drop empties first
      .map(Number)
      .filter((id) => Number.isInteger(id)),
  );
}

/** Decode `?bg=`/`?bgc=` into a background seed. Newer links carry the preset
 * name (`studio`, `custom`, …) so the window's Background control lands on the
 * right segment; `bgc` carries the custom hex. Older links (pre-preset) put a
 * resolved `#rrggbb` straight in `bg` -- treat that as a custom color so those
 * bookmarks still render exactly what they used to. An unknown preset string
 * degrades to the studio default inside `useViewerBackground`. */
function decodeBackground(
  bg: string | undefined,
  bgc: string | undefined,
): { preset: BackgroundPreset; custom?: string } {
  if (!bg) return { preset: "studio" };
  if (bg.startsWith("#")) return { preset: "custom", custom: bg };
  return { preset: bg as BackgroundPreset, custom: bgc };
}

/** The loaded half: the model's GLB parts are known, so it can call
 * `useViewerScene` unconditionally (hook rules forbid it after the early
 * returns above). Seeds the scene from the URL and renders the SAME stage as
 * the inline tab and Expand dialog -- full parts checklist, per-part colors,
 * Background, and Lighting -- so the pop-out is no longer a bare canvas. */
function ViewerWindow({ slug, files, search }: { slug: string; files: FileOut[]; search: WindowSearch }) {
  const requestedIds = parseIds(search.ids);
  const validRequested = files.filter((file) => requestedIds.has(file.id)).map((file) => file.id);
  // No ids -> show every part (the old "open the whole model" behavior). Ids
  // that no longer match any part (a stale link) fall back to the first part
  // rather than a blank window; the checklist lets the user pick from there.
  const checkedIds =
    requestedIds.size === 0
      ? files.map((file) => file.id)
      : validRequested.length > 0
        ? validRequested
        : [files[0].id];

  const { stageProps } = useViewerScene({
    slug,
    files,
    // The URL carries only the parts this window was opened for, so writing
    // that subset back to the per-model color store would drop the rest.
    persistColors: false,
    initial: {
      checkedIds,
      colors: decodePartColors(search.colors),
      background: decodeBackground(search.bg, search.bgc),
      lighting: (search.light ?? "studio") as LightingPreset,
      panelOpen: true,
    },
  });

  return (
    <div className="flex h-svh w-svw flex-col gap-2 bg-background p-2">
      <ViewerStage {...stageProps} variant="window" showExpand={false} showWindowButtons={false} />
    </div>
  );
}

/** Standalone, chrome-less 3D viewer (M8 G1) rendered in its own browser
 * window via `window.open('/viewer/$slug?ids=&bg=&bgc=&light=&colors=')`.
 * Self-contained: it re-fetches the model and derives its parts + appearance
 * from the URL, so multiple windows (or one part per window) are independent.
 * Lives OUTSIDE the AppShell (no nav rail) but inside the session guard. */
export function ViewerWindowPage() {
  const { slug } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as WindowSearch;
  const modelQuery = useModel(slug ?? "");

  if (modelQuery.isLoading) {
    return (
      <div className="h-svh w-svw bg-background p-2">
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    );
  }

  const model = modelQuery.data;
  if (!model) return <Centered>Model not found.</Centered>;

  const glbable = glbFiles(model);
  if (glbable.length === 0) return <Centered>No renderable parts selected.</Centered>;

  return <ViewerWindow slug={model.slug} files={glbable} search={search} />;
}
