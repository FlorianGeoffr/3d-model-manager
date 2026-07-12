/**
 * Config persistence over `chrome.storage.local`. This is the one place
 * that reads/writes the extension's settings object:
 *   { appBaseUrl: string, apiToken: string, autoCourier: boolean,
 *     lastMakerworldHash: string|null, autoSyncCollections: boolean,
 *     lastCollectionsHash: string|null,
 *     lastCollectionItemsHash: Array<{listId: string, hash: string}> }
 *
 * `apiToken` living in `chrome.storage.local` is unavoidable — it's the
 * credential the extension authenticates with — but nothing else here ever
 * stores a raw secret: the MakerWorld cookie itself is never persisted,
 * only its hash (`lastMakerworldHash`, produced by `courier.js`).
 * `lastCollectionsHash` (import-health branch T5) is the same idea applied
 * to the background auto-sync's throttle -- a hash of the last-pushed
 * collections payload, not the payload itself (see `syncFlow.js`'s
 * `hashCollectionsPayload`). `lastCollectionItemsHash` (M11) is the
 * per-collection counterpart for the detail-page auto-sync
 * (`syncFlow.js`'s `hashCollectionItemsPayload`/`upsertCollectionItemsHash`)
 * -- deliberately an ARRAY of `{listId, hash}` pairs rather than an object
 * keyed by listId, since MakerWorld list ids are canonical-numeric-looking
 * strings and every JS engine silently reorders a plain object's
 * INTEGER-like keys to ascending numeric order regardless of insertion
 * order, which would break "prune to the last 50 by recency".
 *
 * Uses `chrome.*`, so this module is NOT unit-tested directly (see
 * `courier.test.js` / `detect.test.js` for the pure logic this wraps).
 */

const STORAGE_KEY = "config";

const DEFAULTS = {
  appBaseUrl: "",
  apiToken: "",
  autoCourier: true,
  lastMakerworldHash: null,
  autoSyncCollections: true,
  lastCollectionsHash: null,
  lastCollectionItemsHash: [],
};

/**
 * @returns {Promise<{appBaseUrl:string, apiToken:string, autoCourier:boolean, lastMakerworldHash:string|null, autoSyncCollections:boolean, lastCollectionsHash:string|null, lastCollectionItemsHash:Array<{listId:string, hash:string}>}>}
 */
export async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

/**
 * Shallow-merges `patch` into the persisted config and returns the result.
 * @param {Partial<{appBaseUrl:string, apiToken:string, autoCourier:boolean, lastMakerworldHash:string|null, autoSyncCollections:boolean, lastCollectionsHash:string|null, lastCollectionItemsHash:Array<{listId:string, hash:string}>}>} patch
 */
export async function setConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** True once both an app base URL and an API token have been entered. */
export function isConfigured(config) {
  return Boolean(config?.appBaseUrl && config?.apiToken);
}
