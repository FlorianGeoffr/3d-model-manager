/**
 * Thin fetch client for the app's `/api/ext/*` plane. No `chrome.*` here —
 * takes `fetch` from the ambient global (available in both the MV3 service
 * worker and Node 18+/20+), so this stays unit-testable with a stubbed
 * `fetch` in Node's test runner without any DOM/extension shims.
 *
 * Every method returns a normalized result instead of throwing, so callers
 * (popup/background) never need a try/catch around a network call:
 *   { ok: boolean, status: number, data: unknown, error: string|null }
 */

/**
 * @param {{ baseUrl: string, token: string }} opts
 */
export function createClient({ baseUrl, token }) {
  const root = String(baseUrl ?? "").replace(/\/+$/, "");

  async function request(path, { method = "GET", body } = {}) {
    const headers = {
      Authorization: `Bearer ${token}`,
    };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${root}/api/ext${path}`, {
        method,
        headers,
        body: payload,
      });
    } catch (err) {
      // Network-level failure (offline, DNS, CORS, refused connection —
      // never logs the token, only the generic failure reason).
      return { ok: false, status: 0, data: null, error: err?.message || "Network error" };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Non-JSON or empty body is fine for a 2xx with no content; for a
      // non-2xx with no JSON body we fall back to statusText below.
      data = null;
    }

    if (response.ok) {
      return { ok: true, status: response.status, data, error: null };
    }

    const detail =
      (data && typeof data === "object" && "detail" in data && data.detail) ||
      response.statusText ||
      `Request failed (${response.status})`;
    return { ok: false, status: response.status, data, error: String(detail) };
  }

  return {
    ping() {
      return request("/ping");
    },
    createImport(url) {
      return request("/imports", { method: "POST", body: { url } });
    },
    setMakerworldCredential(cookieValue) {
      return request("/credentials/makerworld", { method: "POST", body: { token: cookieValue } });
    },
  };
}
