/**
 * Generate a random v4 UUID that works in **non-secure** browsing contexts.
 *
 * `crypto.randomUUID()` is only defined in a secure context — HTTPS, or plain
 * HTTP served from `localhost`/`127.0.0.1`. This app is self-hosted and
 * routinely reached over plain HTTP via a LAN IP or hostname, where
 * `crypto.randomUUID` is `undefined` (calling it throws "crypto.randomUUID is
 * not a function"). `crypto.getRandomValues()` is *not* gated to secure
 * contexts, so we fall back to building the UUID from it by hand.
 *
 * Used only for client-side identifiers (e.g. upload-queue row keys), never as
 * a value the backend interprets — but it still returns a well-formed v4 UUID.
 */
export function randomId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }

  // Fallback: derive a v4 UUID from 16 random bytes (RFC 4122 §4.4).
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
