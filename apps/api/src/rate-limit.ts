export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now = performance.now(),
  ) {
    if (!(ratePerSecond > 0) || !(burst >= 1)) throw new Error("token bucket rate and burst must be positive");
    this.tokens = burst;
    this.updatedAt = now;
  }

  allow(now = performance.now()): boolean {
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

type BucketEntry = { bucket: TokenBucket; lastSeenAt: number };

/** Bounded, expiring per-principal limiter. Keys are held in memory only. */
export class KeyedTokenBucket {
  private readonly entries = new Map<string, BucketEntry>();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly maximumKeys = 10_000,
    private readonly idleTtlMs = 15 * 60 * 1000,
  ) {
    if (!Number.isInteger(maximumKeys) || maximumKeys < 1 || idleTtlMs <= 0) {
      throw new Error("keyed token bucket bounds must be positive");
    }
  }

  allow(key: string, now = performance.now()): boolean {
    for (const [candidate, entry] of this.entries) {
      if (now - entry.lastSeenAt >= this.idleTtlMs) this.entries.delete(candidate);
    }
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maximumKeys) {
        const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0];
        if (oldest) this.entries.delete(oldest[0]);
      }
      entry = { bucket: new TokenBucket(this.ratePerSecond, this.burst, now), lastSeenAt: now };
      this.entries.set(key, entry);
    }
    entry.lastSeenAt = now;
    return entry.bucket.allow(now);
  }

  get size(): number { return this.entries.size; }
}
