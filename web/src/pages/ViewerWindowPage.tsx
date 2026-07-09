import { Suspense, lazy } from "react";
import { useParams, useSearch } from "@tanstack/react-router";

import { useModel } from "@/api/library";
import { decodePartColors } from "@/components/viewer/partColors";
import { glbFiles, glbUrl } from "@/components/viewer/viewable";
import { Skeleton } from "@/components/ui/skeleton";

// Same lazy boundary as ViewerTab: keep three.js/R3F/drei out of the main
// bundle (Global Constraints "BUNDLE RULE").
const ModelViewer = lazy(() => import("@/components/viewer/ModelViewer"));

const DEFAULT_BG = "#a1a1aa";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-svh w-svw place-items-center bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Standalone, chrome-less 3D viewer (M8 G1) rendered in its own browser
 * window via `window.open('/viewer/$slug?ids=&bg=&colors=')`. Self-contained:
 * it re-fetches the model and derives its parts from the URL, so multiple
 * windows (or one part per window) are independent. Lives OUTSIDE the AppShell
 * (no nav rail) but inside the session guard. */
export function ViewerWindowPage() {
  const { slug } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { ids?: string; bg?: string; colors?: string };
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
  const requestedIds = new Set(
    (search.ids ?? "")
      .split(",")
      .filter((segment) => segment !== "") // Number("") is 0, not NaN -- drop empties first
      .map(Number)
      .filter((id) => Number.isInteger(id)),
  );
  const colors = decodePartColors(search.colors);
  const parts = glbable
    .filter((file) => requestedIds.size === 0 || requestedIds.has(file.id))
    .map((file) => ({ id: file.id, url: glbUrl(file), color: colors[file.id] }));

  if (parts.length === 0) return <Centered>No renderable parts selected.</Centered>;

  return (
    <div className="h-svh w-svw bg-background">
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        <ModelViewer parts={parts} background={search.bg ?? DEFAULT_BG} />
      </Suspense>
    </div>
  );
}
