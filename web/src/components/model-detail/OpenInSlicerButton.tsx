/**
 * "Open in slicer" split button (R10-C, plan item 11): posts
 * `POST /files/{id}/slicer-link` for a signed, short-lived download URL and
 * hands it to a desktop slicer via its `<scheme>://open?file=<url>` deep
 * link -- the slicer fetches the URL itself, with no session cookie, so the
 * link has to carry its own (signed, expiring) auth (`app.services.signed_urls`
 * on the backend).
 *
 * Only offered for files whose format a desktop slicer actually opens raw
 * geometry from (stl/3mf/step/obj) -- not sliced outputs (gcode/gcode_3mf),
 * which already have their own "Print" action (`SendToPrinterButton`).
 *
 * Remembers the last-picked slicer in localStorage and promotes it to the
 * button's primary (non-dropdown) action next time.
 */
import { useState } from "react";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/api/client";
import type { BlobFormat, FileOut } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SlicerOption {
  id: string;
  label: string;
  scheme: string;
}

/** Order matters only for menu display -- the first entry is just the
 * fallback default when nothing's been picked yet. */
export const SLICER_OPTIONS: SlicerOption[] = [
  { id: "orcaslicer", label: "OrcaSlicer", scheme: "orcaslicer" },
  { id: "bambustudio", label: "Bambu Studio", scheme: "bambustudio" },
  { id: "prusaslicer", label: "PrusaSlicer", scheme: "prusaslicer" },
  { id: "elegooslicer", label: "Elegoo Slicer", scheme: "elegooslicer" },
];

const ELIGIBLE_FORMATS: ReadonlySet<BlobFormat> = new Set<BlobFormat>(["stl", "3mf", "step", "obj"]);

/** Raw-geometry formats a desktop slicer can open -- excludes sliced
 * outputs (`gcode`, `gcode_3mf`) and non-model files (images, `other`). */
export function isSlicerEligible(file: FileOut): boolean {
  return ELIGIBLE_FORMATS.has(file.format);
}

export const LAST_SLICER_STORAGE_KEY = "tdmm.lastSlicer";

function readLastSlicer(): SlicerOption {
  try {
    const id = localStorage.getItem(LAST_SLICER_STORAGE_KEY);
    return SLICER_OPTIONS.find((s) => s.id === id) ?? SLICER_OPTIONS[0];
  } catch {
    return SLICER_OPTIONS[0];
  }
}

function rememberLastSlicer(id: string): void {
  try {
    localStorage.setItem(LAST_SLICER_STORAGE_KEY, id);
  } catch {
    // Best-effort only -- a private window/blocked storage just means the
    // primary action doesn't persist between visits.
  }
}

interface SlicerLinkResponse {
  url: string;
  expires_at: string;
}

export function OpenInSlicerButton({
  file,
  size = "icon-sm",
}: {
  file: FileOut;
  size?: "icon-sm" | "default";
}) {
  const [lastSlicer, setLastSlicer] = useState<SlicerOption>(readLastSlicer);
  const [pending, setPending] = useState(false);

  async function openIn(slicer: SlicerOption) {
    setLastSlicer(slicer);
    rememberLastSlicer(slicer.id);
    setPending(true);
    try {
      const { url } = await api.post<SlicerLinkResponse>(`/files/${file.id}/slicer-link`);
      toast(`Opening in ${slicer.label}…`, {
        description: `If nothing happens, install ${slicer.label} or check its URL-handler setting.`,
      });
      window.location.assign(`${slicer.scheme}://open?file=${encodeURIComponent(url)}`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.detail : `Could not open ${file.rel_path} in a slicer`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inline-flex">
      <Button
        type="button"
        variant="outline"
        size={size}
        className="rounded-r-none"
        disabled={pending}
        aria-label={`Open ${file.rel_path} in ${lastSlicer.label}`}
        onClick={() => void openIn(lastSlicer)}
      >
        {size === "icon-sm" ? <ExternalLinkIcon className="size-4" /> : `Open in ${lastSlicer.label}`}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size={size}
            className="rounded-l-none border-l-0 px-1.5"
            disabled={pending}
            aria-label="Choose slicer"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {SLICER_OPTIONS.map((slicer) => (
            <DropdownMenuItem key={slicer.id} onSelect={() => void openIn(slicer)}>
              {slicer.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
