// Tiny shared helper for every *StorageService in this directory
// (ModelStorageService, and its siblings for sessions/imported geometry/
// voxelization/zones) - all wrapped in try/catch since localStorage can
// throw (private browsing with storage blocked, quota exceeded) and
// JSON.parse can throw on corrupt/foreign data; losing reload-survival is
// far better than crashing the app over either.
export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // See this file's own header comment.
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // See this file's own header comment.
  }
}

// Every key any *StorageService in this directory ever writes starts with
// this - not each service's own STORAGE_KEY_PREFIX repeated here, since new
// storage services (or new keys within an existing one) would then need
// this file edited too just to stay reachable by a full reset. One shared
// prefix instead keeps "clear absolutely everything" correct by construction.
const SOLVIX_KEY_PREFIX = 'solvix:';

// The user-facing "почати з чистого листа" reset - wipes every session,
// model, imported reference, voxelization and zone ever persisted, for
// every session, not just the active one. Deliberately does NOT try to
// also reset each root-scoped service's own in-memory state (KeyedStores,
// signals, live GPU resources scattered across WorldCanvasComponent/
// zone-painting/etc) - correctly tearing all of that down by hand is far
// more invasive and error-prone than just reloading the page right after
// this runs, which gets the exact same result (every service re-reads from
// now-empty storage on construction) for free.
export function clearAllSolvixStorage(): void {
  try {
    Object.keys(localStorage)
      .filter(key => key.startsWith(SOLVIX_KEY_PREFIX))
      .forEach(key => localStorage.removeItem(key));
  } catch {
    // See this file's own header comment.
  }
}
