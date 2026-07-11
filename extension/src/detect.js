/**
 * Pure, `chrome`-free URL detection for the three supported gallery sites.
 * Mirrors the backend's per-importer `canonicalize` regexes (see
 * `backend/app/importers/{makerworld,thingiverse,printables}.py`) so the
 * extension's "is this a model page" check agrees with what the app will
 * actually accept — the backend still does the authoritative canonicalize;
 * this is only a loose gate for enabling the popup button / context menu.
 */

const SITES = [
  {
    site: "makerworld",
    hosts: new Set(["makerworld.com", "www.makerworld.com"]),
    idPattern: /models\/(\d+)/i,
  },
  {
    site: "thingiverse",
    hosts: new Set(["thingiverse.com", "www.thingiverse.com"]),
    idPattern: /(?:thing:|.*?[?&]thing=)(\d+)/i,
  },
  {
    site: "printables",
    hosts: new Set(["printables.com", "www.printables.com"]),
    idPattern: /model\/(\d+)/i,
  },
];

/**
 * @param {string} url
 * @returns {"makerworld"|"thingiverse"|"printables"|null}
 */
export function detectSite(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = (parsed.hostname || "").toLowerCase();
  for (const entry of SITES) {
    if (entry.hosts.has(host)) {
      return entry.site;
    }
  }
  return null;
}

/**
 * True iff `url` is on a supported gallery host AND matches that site's
 * model-id pattern (path segment or query string, per site).
 * @param {string} url
 * @returns {boolean}
 */
export function isModelPage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = (parsed.hostname || "").toLowerCase();
  const entry = SITES.find((s) => s.hosts.has(host));
  if (!entry) {
    return false;
  }
  // Test against pathname + search so query-string id shapes (Thingiverse's
  // `?thing=<id>`) match without needing the full href (which would also
  // match a fragment/hash containing digits after "thing:" incidentally —
  // acceptable for this loose gate).
  const target = `${parsed.pathname}${parsed.search}`;
  return entry.idPattern.test(target);
}
