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
