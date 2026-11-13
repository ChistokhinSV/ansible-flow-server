// Slows down guessing: after a few wrong passwords for a login, or many from one address, sign-in
// is refused for a while. Kept in memory: one server process, and a restart forgets it.

export interface LimiterOptions {
  /** How many failures are allowed within the window. */
  max: number;
  windowMs: number;
}

export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly options: LimiterOptions) {}

  private recent(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Seconds until `key` may try again; 0 when it may now. */
  retryAfter(key: string, now = Date.now()): number {
    const kept = this.recent(key, now);
    if (kept.length < this.options.max) return 0;
    return Math.ceil(((kept[0] as number) + this.options.windowMs - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    this.failures.set(key, [...this.recent(key, now), now]);
    // A flood of made-up logins must not grow the map without end.
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k, now);
  }

  /** A success: the count for `key` starts again. */
  clear(key: string): void {
    this.failures.delete(key);
  }
}
