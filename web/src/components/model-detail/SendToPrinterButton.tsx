/**
 * Per-sliced-file "Print" button + send dialog (M4 Task 8, Files tab): only
 * renders for a sliced `.gcode.3mf` blob (`format === "gcode_3mf"`), and
 * only while the printer feature is on and at least one printer is
 * configured -- otherwise it self-hides rather than showing a disabled
 * control. Submits `POST /printers/{id}/print`.
 */
import { useState } from "react";
import { PrinterIcon } from "lucide-react";

import { ApiError } from "@/api/client";
import { useFeatures } from "@/api/features";
import { usePrinters, useStartPrint } from "@/api/printers";
import type { FileOut, PrinterOut } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function SendToPrinterButton({ file }: { file: FileOut }) {
  const features = useFeatures();
  const enabled = !!features.data?.printer_enabled;
  const printers = usePrinters({ enabled });

  if (!enabled || file.format !== "gcode_3mf" || !printers.data || printers.data.length === 0) return null;
  return <SendDialog file={file} printers={printers.data} />;
}

function SendDialog({ file, printers }: { file: FileOut; printers: PrinterOut[] }) {
  const [open, setOpen] = useState(false);
  const [printerId, setPrinterId] = useState(printers[0].id);
  const [plate, setPlate] = useState(file.meta?.plates?.[0]?.index ?? 1);
  const [useAms, setUseAms] = useState(false);
  const [bedLevelling, setBedLevelling] = useState(true);
  const [flowCali, setFlowCali] = useState(true);
  const [timelapse, setTimelapse] = useState(false);
  const start = useStartPrint(printerId);
  const plates = file.meta?.plates ?? [];

  function submit() {
    start.mutate(
      {
        file_id: file.id,
        plate,
        use_ams: useAms,
        ams_mapping: [0],
        bed_levelling: bedLevelling,
        flow_cali: flowCali,
        timelapse,
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Print ${file.rel_path}`}>
          <PrinterIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send {file.rel_path} to a printer</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">
            Printer
            <Select value={String(printerId)} onValueChange={(v) => setPrinterId(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {printers.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {plates.length > 1 ? (
            <label className="block text-sm">
              Plate
              <Select value={String(plate)} onValueChange={(v) => setPlate(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plates.map((pl) => (
                    <SelectItem key={pl.index} value={String(pl.index)}>
                      Plate {pl.index}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useAms} onChange={(e) => setUseAms(e.target.checked)} /> Use AMS
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={bedLevelling} onChange={(e) => setBedLevelling(e.target.checked)} /> Bed
            levelling
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={flowCali} onChange={(e) => setFlowCali(e.target.checked)} /> Flow
            calibration
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={timelapse} onChange={(e) => setTimelapse(e.target.checked)} /> Timelapse
          </label>
          {start.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {start.error instanceof ApiError ? start.error.detail : "Could not start print"}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" onClick={submit} disabled={start.isPending}>
            {start.isPending ? "Sending..." : "Send to printer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
