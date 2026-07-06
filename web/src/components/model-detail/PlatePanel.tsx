import { ImageIcon } from "lucide-react";

import { humanizeDuration } from "@/lib/format";
import type { FileOut, PlateOut } from "@/api/types";

/** `{printer_model} · {nozzle} mm nozzle · {layer_height} mm layers`, skipping
 * any part whose source value is null (Task 9 brief). */
function headerLine(file: FileOut): string | null {
  const meta = file.meta;
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.printer_model) parts.push(meta.printer_model);
  if (meta.nozzle !== null) parts.push(`${meta.nozzle} mm nozzle`);
  if (meta.layer_height !== null) parts.push(`${meta.layer_height} mm layers`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `Plate {index} · {humanizeDuration(prediction_s)} · {weight_g} g`, skipping
 * any part whose source value is null (Task 9 brief). */
function plateCaption(plate: PlateOut): string {
  const parts = [
    `Plate ${plate.index}`,
    plate.prediction_s !== null ? humanizeDuration(plate.prediction_s) : null,
    plate.weight_g !== null ? `${Math.round(plate.weight_g)} g` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function PlateCard({ blobHash, plate }: { blobHash: string; plate: PlateOut }) {
  return (
    <div className="w-48 shrink-0 space-y-2 rounded-lg border border-border p-3">
      <div className="flex aspect-square items-center justify-center overflow-hidden rounded bg-muted">
        {plate.thumbnail_available ? (
          <img
            src={`/api/blobs/${blobHash}/plates/${plate.index}/thumb`}
            alt={`Plate ${plate.index}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" />
        )}
      </div>
      <p className="text-xs text-muted-foreground">{plateCaption(plate)}</p>
      {plate.filaments.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {plate.filaments.map((filament, index) => (
            <span
              key={index}
              className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px]"
            >
              {filament.color ? (
                <span
                  className="size-2 shrink-0 rounded-full border border-border/50"
                  style={{ backgroundColor: filament.color }}
                />
              ) : null}
              {filament.type ?? "Filament"}
              {filament.used_g !== null ? ` ${Math.round(filament.used_g)} g` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-plate time/weight/filament breakdown for a sliced file (Task 9),
 * replacing the ViewerTab's earlier sliced-file placeholder card. */
export function PlatePanel({ file }: { file: FileOut }) {
  const plates = file.meta?.plates ?? [];
  const header = headerLine(file);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {header ? <p className="text-sm text-muted-foreground">{header}</p> : null}
      {plates.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No plate details available yet.</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {plates.map((plate) => (
            <PlateCard key={plate.index} blobHash={file.blob_hash} plate={plate} />
          ))}
        </div>
      )}
    </div>
  );
}
