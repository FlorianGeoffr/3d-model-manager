import type { BlobFormat, ModelDetail } from "@/api/types";

export interface ModelFilament {
  color: string | null;
  material: string | null;
}

/** Distinct (color, material) filament pairs across the current revision's
 * sliced-plate metadata — the source for the header's filament chips. Pairs
 * with neither a color nor a material are ignored. */
export function modelFilaments(model: ModelDetail): ModelFilament[] {
  const files = model.current_revision?.files ?? [];
  const seen = new Map<string, ModelFilament>();
  for (const file of files) {
    for (const plate of file.meta?.plates ?? []) {
      for (const filament of plate.filaments) {
        if (!filament.color && !filament.type) continue;
        const key = `${filament.color ?? ""}|${filament.type ?? ""}`;
        if (!seen.has(key)) seen.set(key, { color: filament.color, material: filament.type });
      }
    }
  }
  return [...seen.values()];
}

/** Distinct blob formats present in the current revision, in first-seen order. */
export function revisionFormats(model: ModelDetail): BlobFormat[] {
  const files = model.current_revision?.files ?? [];
  return [...new Set(files.map((file) => file.format))];
}
