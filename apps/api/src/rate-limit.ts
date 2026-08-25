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
