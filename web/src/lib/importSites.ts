import type { ImportSite } from "@/api/types";

export interface DetectedSite {
  site: ImportSite | null;
  label: string;
  supported: boolean; // false for makerworld (deferred) and null (unknown)
}

const HOSTS: Record<string, { site: ImportSite; label: string; supported: boolean }> = {
  "thingiverse.com": { site: "thingiverse", label: "Thingiverse", supported: true },
  "printables.com": { site: "printables", label: "Printables", supported: true },
  "makerworld.com": { site: "makerworld", label: "MakerWorld", supported: false },
};

/** Client-side site detection for the /import preview. A MakerWorld URL is
 * recognized (so we can show a friendly "not available yet") but not
 * supported; anything else is unknown. Mirrors the backend's registry. */
export function detectSite(rawUrl: string): DetectedSite {
  let host = "";
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { site: null, label: "", supported: false };
  }
  const hit = HOSTS[host];
  return hit ? { ...hit } : { site: null, label: "", supported: false };
}
