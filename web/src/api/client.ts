/**
 * Thin fetch wrapper for the `/api` backend.
 *
 * - Always sends cookies (`credentials: "include"`) so the `tdmm_session`
 *   cookie round-trips.
 * - Serializes/deserializes JSON automatically.
 * - Throws a typed `ApiError { status, detail }` for any non-2xx response.
 * - On 401 (the backend's "not authenticated at all" signal — see
 *   `backend/app/api/deps.py`), hard-redirects to `/login`, *unless* we're
 *   already there. That carve-out matters because the login page itself
 *   calls `GET /auth/me` (via `useAuth`) to decide what to render; a 401
 *   from that call is the expected, unauthenticated case and must not
 *   trigger a redirect loop back to the page we're already on.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

const API_BASE = "/api";

interface JsonRequestInit extends Omit<RequestInit, "body"> {
  body?: unknown;
}

function isUnauthenticatedRedirectExempt(): boolean {
  return window.location.pathname === "/login";
}

async function extractDetail(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (
      data !== null &&
      typeof data === "object" &&
      "detail" in data &&
      typeof (data as { detail: unknown }).detail === "string"
    ) {
      return (data as { detail: string }).detail;
    }
  } catch {
    // Response body wasn't JSON (or was empty) — fall through to statusText.
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

async function request<T>(path: string, init: JsonRequestInit = {}): Promise<T> {
  const { body, headers, ...rest } = init;

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: "include",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && !isUnauthenticatedRedirectExempt()) {
    window.location.assign("/login");
    throw new ApiError(401, await extractDetail(response));
  }

  if (!response.ok) {
    throw new ApiError(response.status, await extractDetail(response));
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
