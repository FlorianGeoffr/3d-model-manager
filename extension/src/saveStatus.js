/**
 * Pure polling loop for the popup's post-save status check (import-health
 * branch T4). `POST /ext/imports` only proves an Import ROW was created --
 * this polls `GET /ext/imports/{id}` (via the injected `fetchStatus`) until
 * the import reaches a terminal state, so the popup can report what
 * actually happened instead of stopping at "row created."
 *
 * No `chrome.*`/`fetch`/timers here: `fetchStatus` and `sleep` are injected
 * so this stays unit-testable with fakes, and polling is driven by an
 * attempt COUNT (`ceil(timeoutMs / intervalMs)`) rather than wall-clock
 * time, so a test never has to wait out a real 15s timeout to see one.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_INTERVAL_MS = 2000;

/**
 * @param {object} opts
 * @param {(importId: string|number) => Promise<{ok: boolean, status: number, data: unknown, error: string|null}>} opts.fetchStatus
 *   Normalized `api.js`-shaped result -- never expected to throw.
 * @param {string|number} opts.importId
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @param {(ms: number) => Promise<void>} opts.sleep
 * @returns {Promise<{outcome: "done"|"failed"|"timeout", error?: string}>}
 */
export async function pollImportStatus({
  fetchStatus,
  importId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  sleep,
}) {
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(intervalMs);
    }

    const result = await fetchStatus(importId);
    const data = result && result.ok ? result.data : null;
    const state = data && typeof data === "object" ? data.state : null;

    if (state === "done") {
      return { outcome: "done" };
    }
    if (state === "failed") {
      return { outcome: "failed", error: (data && data.error) || "Import failed." };
    }
    // Any other case -- a non-terminal state (pending/fetching/downloading)
    // OR a fetch error (network hiccup, momentary 5xx) -- just keeps
    // polling. A popup's network is flaky enough that a transient failure
    // shouldn't short-circuit straight to "failed"; it only gives up once
    // attempts run out, same as a stuck import.
  }

  return { outcome: "timeout" };
}
