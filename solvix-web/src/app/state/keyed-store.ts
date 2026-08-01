// Lazy "get value for this key, create a default the first time it's asked
// for" store - the same pattern needed everywhere something is scoped per
// session (or per session+world): ActiveWorldService, SharedModelService,
// WorldRepresentationService, and WorldCanvasComponent's per-session camera
// state all need exactly this, keyed by sessionId (and, nested, worldIndex).
export class KeyedStore<K, V> {
  private readonly map = new Map<K, V>();

  getOrCreate(key: K, create: () => V): V {
    let value = this.map.get(key);
    if (value === undefined) {
      value = create();
      this.map.set(key, value);
    }
    return value;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  // Drops every entry whose key is NOT in `validKeys` - how consumers clean
  // up after a session closes, without needing to know about "closing" as
  // an event: they just re-assert "these are the sessions that still
  // exist" whenever SessionsService.sessions() changes. `onRemove` runs
  // before each entry is dropped, for callers that need to release
  // something (e.g. dispose GPU resources) before losing the reference.
  pruneTo(validKeys: Iterable<K>, onRemove?: (value: V, key: K) => void): void {
    const valid = new Set(validKeys);
    for (const [key, value] of this.map) {
      if (!valid.has(key)) {
        onRemove?.(value, key);
        this.map.delete(key);
      }
    }
  }
}