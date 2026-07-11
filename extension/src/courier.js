/**
 * Pure-ish cookie-courier helpers. Uses only Web Crypto (`crypto.subtle`,
 * available both in the MV3 service worker and in Node 20+), no `chrome.*`.
 *
 * We store only a HASH of the last-pushed cookie value in extension
 * storage (never the raw cookie) so the extension doesn't keep a second
 * copy of the secret at rest — `shouldPush` diffs the *current* cookie
 * against that hash to decide whether a re-push is needed.
 */

/**
 * SHA-256 hash of `value`, returned as a lowercase hex string.
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function hashToken(value) {
  const bytes = new TextEncoder().encode(value ?? "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * True when `currentValue` is non-empty and its hash differs from
 * `lastPushedHash` (i.e. the cookie is new or has changed since the last
 * successful courier push).
 * @param {string|null|undefined} currentValue
 * @param {string|null|undefined} lastPushedHash
 * @returns {Promise<boolean>}
 */
export async function shouldPush(currentValue, lastPushedHash) {
  if (!currentValue) {
    return false;
  }
  const currentHash = await hashToken(currentValue);
  return currentHash !== lastPushedHash;
}
