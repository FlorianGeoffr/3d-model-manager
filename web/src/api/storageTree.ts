/**
 * Query hook for the folder-browser view (R13b): `GET /storage/tree?path=`
 * lists the immediate subdirectories and directly-contained models under a
 * raw storage path, one level at a time -- navigation happens by re-querying
 * with a new `path`, not by fetching a whole tree up front.
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { StorageTreeOut } from "@/api/types";

function buildTreeUrl(path: string): string {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  const query = params.toString();
  return query ? `/storage/tree?${query}` : "/storage/tree";
}

export function useStorageTree(path: string) {
  return useQuery({
    queryKey: ["storage", "tree", path] as const,
    queryFn: () => api.get<StorageTreeOut>(buildTreeUrl(path)),
  });
}
