/**
 * Printer setup wizard on Settings (M4 Task 8): gated on the
 * `printer_enabled` feature flag (`GET /features`); when on, lists
 * configured printers with an edit form each (Test connection, Save,
 * confirm-gated Delete) plus an "Add a printer" form. Mirrors
 * `StorageSettingsCard`'s draft-state + pending-disable + `role="alert"`
 * error conventions, and its masked-secret UX for `access_code`:
 * `PrinterOut` never carries the code (only `access_code_set`), so the
 * input always starts blank -- typing a value sends it, leaving it blank
 * means "keep the stored one" (PATCH only).
 *
 * Round 8 T1 hardening: the serial is now REQUIRED (server-side too --
 * `PrinterCreate`/`PrinterUpdate` reject a blank/null serial), and every
 * other create field is checked client-side before the request ever goes
 * out -- a "Detect" button beside the Serial input reads the serial
 * straight off the printer's TLS cert (`POST /printers/detect-serial`) so
 * the user doesn't have to hunt for it on the printer's screen.
 */
import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import { ApiError } from "@/api/client";
import { useFeatures } from "@/api/features";
import {
  useCreatePrinter,
  useDeletePrinter,
  useDetectSerial,
  usePrinters,
  useTestPrinter,
  useUpdatePrinter,
} from "@/api/printers";
import type { PrinterOut, PrinterUpdate } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

interface PrinterDraft {
  name: string;
  host: string;
  serial: string;
  model: string;
  access_code: string;
}

type DraftErrors = Partial<Record<keyof PrinterDraft, string>>;

function emptyDraft(): PrinterDraft {
  return { name: "", host: "", serial: "", model: "", access_code: "" };
}

/** A saved printer's `access_code` is never returned by the API (only
 * `access_code_set`) -- the field always seeds blank, which is what "leave
 * unchanged" looks like on save (mirrors `StorageBackendForm.seedDraft`). */
function seedDraft(printer: PrinterOut): PrinterDraft {
  return { name: printer.name, host: printer.host, serial: printer.serial, model: printer.model ?? "", access_code: "" };
}

export function PrinterSetupCard() {
  const features = useFeatures();

  if (features.isLoading) return <Skeleton className="h-48 w-full rounded-xl" />;

  if (!features.data?.printer_enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Printer setup</CardTitle>
          <CardDescription>
            Printer integration is disabled (set <code>PRINTER_ENABLED</code>).
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <EnabledPrinterSetupCard />;
}

function EnabledPrinterSetupCard() {
  const printers = usePrinters();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Printer setup</CardTitle>
        <CardDescription>Add and manage the printers this app can send sliced files to.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {printers.isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : printers.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {printers.error instanceof ApiError ? printers.error.detail : "Couldn't load printers."}
          </p>
        ) : (
          (printers.data ?? []).map((printer) => <PrinterEditor key={printer.id} printer={printer} />)
        )}
        <div className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-semibold text-foreground">Add a printer</h2>
          <PrinterEditor />
        </div>
      </CardContent>
    </Card>
  );
}

function PrinterEditor({ printer }: { printer?: PrinterOut }) {
  const [draft, setDraft] = useState<PrinterDraft>(() => (printer ? seedDraft(printer) : emptyDraft()));
  const [errors, setErrors] = useState<DraftErrors>({});

  const createPrinter = useCreatePrinter();
  const updatePrinter = useUpdatePrinter(printer?.id ?? -1);
  const deletePrinter = useDeletePrinter();
  const testPrinter = useTestPrinter(printer?.id ?? -1);
  const detectSerial = useDetectSerial();

  const saveMutation = printer ? updatePrinter : createPrinter;
  const busy = createPrinter.isPending || updatePrinter.isPending || deletePrinter.isPending;
  const idPrefix = printer ? `printer-${printer.id}` : "printer-new";

  function setField<K extends keyof PrinterDraft>(key: K, value: PrinterDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  /** Serial is required on both create and update (mirrors the backend's
   * `PrinterCreate`/`PrinterUpdate` serial validator); name/host/access_code
   * are only required on create -- an existing printer's row already has
   * them, and a blank `access_code` on update means "keep the stored one". */
  function validate(): boolean {
    const next: DraftErrors = {};
    if (draft.serial.trim() === "") next.serial = "Serial is required.";
    if (!printer) {
      if (draft.name.trim() === "") next.name = "Name is required.";
      if (draft.host.trim() === "") next.host = "Host is required.";
      if (draft.access_code.trim() === "") next.access_code = "Access code is required.";
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function detect() {
    detectSerial.mutate(
      { host: draft.host },
      {
        onSuccess: (result) => {
          if (result.serial) setField("serial", result.serial);
        },
      },
    );
  }

  function save() {
    if (!validate()) return;
    const code = draft.access_code.trim();
    if (printer) {
      // PATCH: a blank access_code means "keep the stored one" -- the key
      // is left out of the body entirely so the backend's `exclude_unset`
      // handling never touches `access_code_enc`.
      const body: PrinterUpdate = {
        name: draft.name,
        host: draft.host,
        serial: draft.serial,
        model: draft.model.trim() === "" ? null : draft.model,
      };
      if (code !== "") body.access_code = code;
      updatePrinter.mutate(body, { onSuccess: () => setField("access_code", "") });
    } else {
      // POST: `access_code` is a required field on `PrinterCreate` (a new
      // printer has no stored code to fall back to) -- `validate()` above
      // already blocked a blank one client-side, so this always sends a
      // real value.
      createPrinter.mutate(
        {
          name: draft.name,
          host: draft.host,
          serial: draft.serial,
          model: draft.model.trim() === "" ? null : draft.model,
          access_code: code,
        },
        { onSuccess: () => setDraft(emptyDraft()) },
      );
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={draft.name}
            onChange={(e) => setField("name", e.target.value)}
            disabled={busy}
            aria-invalid={Boolean(errors.name)}
          />
          {errors.name ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-host`}>Host</Label>
          <Input
            id={`${idPrefix}-host`}
            value={draft.host}
            placeholder="192.168.1.50"
            onChange={(e) => setField("host", e.target.value)}
            disabled={busy}
            aria-invalid={Boolean(errors.host)}
          />
          {errors.host ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.host}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-serial`}>Serial</Label>
          <div className="flex gap-1.5">
            <Input
              id={`${idPrefix}-serial`}
              value={draft.serial}
              onChange={(e) => setField("serial", e.target.value)}
              disabled={busy}
              aria-invalid={Boolean(errors.serial)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || detectSerial.isPending || draft.host.trim() === ""}
              onClick={detect}
            >
              {detectSerial.isPending ? "Detecting..." : "Detect"}
            </Button>
          </div>
          {errors.serial ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.serial}
            </p>
          ) : null}
          {detectSerial.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {detectSerial.error instanceof ApiError ? detectSerial.error.detail : "Could not detect the serial"}
            </p>
          ) : null}
          {detectSerial.data ? (
            <p
              role={detectSerial.data.serial ? undefined : "alert"}
              className={
                detectSerial.data.serial ? "text-xs text-emerald-600 dark:text-emerald-400" : "text-xs text-destructive"
              }
            >
              {detectSerial.data.detail}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-model`}>Model</Label>
          <Input
            id={`${idPrefix}-model`}
            value={draft.model}
            placeholder="A1 mini"
            onChange={(e) => setField("model", e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${idPrefix}-access-code`}>Access code</Label>
          <Input
            id={`${idPrefix}-access-code`}
            type="password"
            value={draft.access_code}
            placeholder={printer?.access_code_set ? "•• (unchanged)" : "LAN access code"}
            onChange={(e) => setField("access_code", e.target.value)}
            disabled={busy}
            autoComplete="new-password"
            aria-invalid={Boolean(errors.access_code)}
          />
          {errors.access_code ? (
            <p role="alert" className="text-xs text-destructive">
              {errors.access_code}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={busy}>
          {saveMutation.isPending ? "Saving..." : printer ? "Save changes" : "Add printer"}
        </Button>
        {printer ? (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || testPrinter.isPending}
              onClick={() => testPrinter.mutate()}
            >
              {testPrinter.isPending ? "Testing..." : "Test connection"}
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive" size="sm" disabled={busy}>
                  <Trash2Icon className="size-3.5" />
                  Delete
                </Button>
              }
              title={`Delete ${printer.name}?`}
              description="This also removes its print job history. This cannot be undone."
              confirmLabel="Delete"
              destructive
              onConfirm={() => deletePrinter.mutate(printer.id)}
            />
          </>
        ) : null}
      </div>

      {saveMutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {saveMutation.error instanceof ApiError ? saveMutation.error.detail : "Could not save printer"}
        </p>
      ) : null}
      {saveMutation.isSuccess ? <p className="text-sm text-emerald-600 dark:text-emerald-400">Saved.</p> : null}

      {deletePrinter.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {deletePrinter.error instanceof ApiError ? deletePrinter.error.detail : "Could not delete printer"}
        </p>
      ) : null}

      {testPrinter.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {testPrinter.error instanceof ApiError ? testPrinter.error.detail : "Could not test connection"}
        </p>
      ) : null}
      {testPrinter.data ? (
        <p role={testPrinter.data.ok ? undefined : "alert"} className={testPrinter.data.ok ? "text-sm text-emerald-600 dark:text-emerald-400" : "text-sm text-destructive"}>
          {testPrinter.data.detail}
          {testPrinter.data.gcode_state ? ` (state: ${testPrinter.data.gcode_state})` : ""}
        </p>
      ) : null}
    </div>
  );
}
