import { lazy, Suspense, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ImageIcon, LayersIcon, LoaderCircleIcon, PrinterIcon } from "lucide-react";

import { useAppSettings } from "@/api/appSettings";
import { useExplodePlates } from "@/api/library";
import { useFeatures } from "@/api/features";
import { usePrinters } from "@/api/printers";
import { Button } from "@/components/ui/button";
import { humanizeDuration } from "@/lib/format";
import { estimatePrintCost, formatPrintCost } from "@/lib/printCost";
import { cn } from "@/lib/utils";
import type { AppSettings, FileOut, PlateOut } from "@/api/types";
import { OpenInSlicerButton } from "@/components/model-detail/OpenInSlicerButton";
import { SendToPrinterDialog } from "@/components/model-detail/SendToPrinterButton";
import { toast } from "sonner";

// `gcode-preview` drives its own three.js/WebGL renderer (Global Constraints
// "BUNDLE RULE") — loaded only once someone actually asks to preview layers.
const GcodePreview = lazy(() => import("@/components/viewer/GcodePreview"));

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

/** `{slicer} · {duration} · {filament_g} g · {layer_height} mm · {infill}%
 * infill · {filament_type}`, skipping any null part (R10-B). */
function metaLine(file: FileOut): string | null {
  const meta = file.meta;
  if (!meta) return null;
  const parts = [
    meta.slicer,
    meta.print_time_s !== null ? humanizeDuration(meta.print_time_s) : null,
    meta.filament_g !== null ? `${Math.round(meta.filament_g)} g` : null,
    meta.layer_height !== null ? `${meta.layer_height} mm layers` : null,
    meta.infill_pct !== null ? `${meta.infill_pct}% infill` : null,
    meta.filament_types && meta.filament_types.length > 0 ? meta.filament_types.join("/") : null,
  ];
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

/** `Plate {index} · {humanizeDuration(prediction_s)} · {weight_g} g [·
 * Est. cost: N.NN]`, skipping any part whose source value is null (Task 9
 * brief; the cost segment is R11-B item 14, added only when app settings
 * are loaded AND at least one of weight/duration is known). */
function plateCaption(plate: PlateOut, settings: AppSettings | undefined): string {
  const cost = settings
    ? estimatePrintCost({ filament_g: plate.weight_g, duration_s: plate.prediction_s }, settings)
    : null;
  const parts = [
    plate.name ? `${plate.name} (P${plate.index})` : `Plate ${plate.index}`,
    plate.prediction_s !== null ? humanizeDuration(plate.prediction_s) : null,
    plate.weight_g !== null ? `${Math.round(plate.weight_g)} g` : null,
    cost !== null ? `Est. cost: ${formatPrintCost(cost)}` : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function PlateCard({
  blobHash,
  plate,
  isSelected,
  onSelect,
  onPrint,
  canPrint,
}: {
  blobHash: string;
  plate: PlateOut;
  isSelected?: boolean;
  onSelect?: () => void;
  onPrint?: () => void;
  canPrint?: boolean;
}) {
  const settings = useAppSettings();
  return (
    <div
      className={cn(
        "w-48 shrink-0 space-y-2 rounded-lg border p-3 transition-all",
        isSelected ? "border-primary ring-1 ring-primary bg-primary/5" : "border-border hover:border-muted-foreground/40",
        onSelect && "cursor-pointer",
      )}
      onClick={onSelect}
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded bg-muted">
        {plate.thumbnail_available ? (
          <img
            src={`/api/blobs/${blobHash}/plates/${plate.index}/thumb`}
            alt={plate.name ? `${plate.name} (Plate ${plate.index})` : `Plate ${plate.index}`}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" />
        )}
        <div className="absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-xs">
          {plate.name ? `${plate.name} (P${plate.index})` : `Plate ${plate.index}`}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{plateCaption(plate, settings.data)}</p>
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
      {canPrint && onPrint ? (
        <div className="pt-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-xs gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              onPrint();
            }}
          >
            <PrinterIcon className="size-3" />
            <span>Print {plate.name ? plate.name : `Plate ${plate.index}`}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Per-plate time/weight/filament breakdown for a sliced file (Task 9),
 * replacing the ViewerTab's earlier sliced-file placeholder card.
 *
 * `compact` (Phase 4 studio) renders just the plate-card strip -- no header/
 * meta lines, no "Preview layers" button -- for the thin strip
 * `StudioSurface` shows beneath the assembly viewer when the model has both
 * ready GLB parts AND sliced files, so neither view has to hide behind the
 * other. */
export function PlatePanel({
  file,
  modelSlug,
  projectId,
  compact = false,
}: {
  file: FileOut;
  modelSlug?: string;
  /** Project ID of the parent model, used to navigate to the folder after exploding plates */
  projectId?: number | null;
  compact?: boolean;
}) {
  const plates = file.meta?.plates ?? [];
  const header = headerLine(file);
  const meta = metaLine(file);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selectedPlate, setSelectedPlate] = useState<number | undefined>(plates[0]?.index);
  const [printDialogPlate, setPrintDialogPlate] = useState<number | null>(null);
  const navigate = useNavigate();

  const features = useFeatures();
  const printerEnabled = !!features.data?.printer_enabled;
  const printers = usePrinters({ enabled: printerEnabled });
  const canPrint = printerEnabled && !!printers.data && printers.data.length > 0;
  const explodePlatesMutation = useExplodePlates();

  return (
    <div className="space-y-3">
      {!compact && header ? <p className="text-sm text-muted-foreground">{header}</p> : null}
      {!compact && meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
      {!compact &&
        (previewOpen ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">
                G-code preview {selectedPlate !== undefined ? `— Plate ${selectedPlate}` : ""}
              </span>
              <Button variant="ghost" size="xs" onClick={() => setPreviewOpen(false)}>
                Close preview
              </Button>
            </div>
            <Suspense
              fallback={
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  Loading g-code preview…
                </div>
              }
            >
              <GcodePreview fileId={file.id} plate={selectedPlate} />
            </Suspense>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <OpenInSlicerButton file={file} size="default" />
            <Button variant="outline" size="sm" onClick={() => setPreviewOpen(true)}>
              <LayersIcon className="size-4" />
              Preview layers {selectedPlate !== undefined && plates.length > 1 ? `(Plate ${selectedPlate})` : ""}
            </Button>
            {modelSlug && plates.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  explodePlatesMutation.mutate(modelSlug, {
                    onSuccess: (exploded) => {
                      toast.success(
                        `${exploded.length} plateaux éclatés en pièces individuelles !`,
                      );
                      // Navigate to the project folder so the user sees the exploded plates
                      const targetProject = exploded[0]?.project_id ?? projectId;
                      if (targetProject != null) {
                        void navigate({ to: "/", search: { project: targetProject } });
                      } else {
                        void navigate({ to: "/" });
                      }
                    },
                    onError: () => {
                      toast.error("Échec de l'éclatement des plateaux");
                    },
                  });
                }}
                disabled={explodePlatesMutation.isPending}
                className="gap-1.5"
                title="Créer une entrée distincte par plateau dans le dossier du projet avec sa miniature et ses métriques"
              >
                <LayersIcon className="size-3.5 text-primary" />
                <span>
                  {explodePlatesMutation.isPending
                    ? "Éclatement…"
                    : `Éclater les plateaux (${plates.length})`}
                </span>
              </Button>
            )}
          </div>
        ))}
      {plates.length === 0 ? (
        !compact && (
          <p className="py-8 text-center text-sm text-muted-foreground">No plate details available yet.</p>
        )
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {plates.map((plate) => (
            <PlateCard
              key={plate.index}
              blobHash={file.blob_hash}
              plate={plate}
              isSelected={selectedPlate === plate.index}
              onSelect={() => setSelectedPlate(plate.index)}
              canPrint={canPrint}
              onPrint={() => setPrintDialogPlate(plate.index)}
            />
          ))}
        </div>
      )}

      {canPrint && printers.data && printDialogPlate !== null ? (
        <SendToPrinterDialog
          file={file}
          printers={printers.data}
          open={printDialogPlate !== null}
          onOpenChange={(open) => {
            if (!open) setPrintDialogPlate(null);
          }}
          initialPlate={printDialogPlate}
        />
      ) : null}
    </div>
  );
}
