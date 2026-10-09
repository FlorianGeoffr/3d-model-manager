import { createContext, useContext } from "react";
import type { ModelSummary } from "@/api/types";

export interface GallerySelectionContextValue {
  selectedIds: Set<number>;
  selectMode: boolean;
  toggleSelected: (id: number, next: boolean) => void;
  handleModifiedClick: (event: React.MouseEvent, index: number) => void;
  handleMergeModels: (target: ModelSummary, sourceIds: number[]) => void;
}

const GallerySelectionContext = createContext<GallerySelectionContextValue | null>(null);

export function useGallerySelection() {
  const ctx = useContext(GallerySelectionContext);
  if (!ctx) {
    throw new Error("useGallerySelection must be used within a GallerySelectionProvider");
  }
  return ctx;
}

export const GallerySelectionProvider = GallerySelectionContext.Provider;
