/**
 * In-process fixed-window rate limiter.
 *
 * Deliberately not Redis: this app is a single process by design, and an
 * in-memory counter has no failure mode of its own. If you ever run several
 * replicas, the limits become per-replica — document it rather than adding a
 * network dependency to the redirect hot path.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export class RateLimiter {
  #buckets = new Map<string, Bucket>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly limit: number,
    readonly windowSeconds: number,
    /** Guards against memory growth from a flood of distinct keys. */
    readonly maxKeys = 50_000,
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.#buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (this.#buckets.size >= this.maxKeys) this.#sweep(now);
      this.#buckets.set(key, { count: 1, resetAt: now + this.windowSeconds * 1000 });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }

    bucket.count++;
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    if (bucket.count > this.limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }
    return { allowed: true, remaining: this.limit - bucket.count, retryAfter };
  }

  /** Forget a key — call after a successful login so one typo isn't punished. */
  reset(key: string): void {
    this.#buckets.delete(key);
  }

  #sweep(now: number): void {
    for (const [k, b] of this.#buckets) {
      if (b.resetAt <= now) this.#buckets.delete(k);
    }
    // Everything is still live and we are at the cap: drop the oldest entries
    // rather than grow without bound.
    if (this.#buckets.size >= this.maxKeys) {
      const excess = this.#buckets.size - Math.floor(this.maxKeys * 0.9);
      let i = 0;
      for (const k of this.#buckets.keys()) {
        if (i++ >= excess) break;
        this.#buckets.delete(k);
      }
    }
  }

  /** Periodic cleanup so idle keys don't linger for the process lifetime. */
  startSweeping(intervalSeconds = 60): void {
    if (this.#sweepTimer !== undefined) return;
    const timer = setInterval(() => this.#sweep(Date.now()), intervalSeconds * 1000);
    this.#sweepTimer = timer;
    // Don't hold the process open just to sweep a Map.
    Deno.unrefTimer(timer);
  }

  stop(): void {
    if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  get size(): number {
    return this.#buckets.size;
  }
}
