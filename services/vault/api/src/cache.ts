// Tiny TTL cache.
//
// Used for /balance/:address — outside-voice review concluded that a static
// client key is theatre against an attacker, but a small per-address TTL cache
// is the actual mitigation against accidental DoS from a tight wallet refresh
// loop. 3 seconds is the HANDOFF default; tune if RPC bills hurt.

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Cache-aside helper: return cached value, or compute, cache, return. */
  async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  /** Evict all entries. Primarily useful in tests. */
  clear(): void {
    this.map.clear();
  }
}
