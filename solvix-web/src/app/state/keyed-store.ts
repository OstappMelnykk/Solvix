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
}