// rateLimit.js — tiny sliding-window limiter for join-code attempts.
//
// Keyed by client IP. Only *failed* code attempts are counted, so a legitimate
// viewer who types the right code is never throttled. Pure logic + injectable
// clock for unit testing.

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.max        max failed attempts per window
   * @param {number} opts.windowMs   window length in ms
   * @param {() => number} [opts.now]
   */
  constructor({ max = 5, windowMs = 60_000, now = Date.now } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, number[]>} key -> timestamps of recent failures */
    this.hits = new Map();
  }

  #prune(key, t) {
    const arr = this.hits.get(key);
    if (!arr) return [];
    const cutoff = t - this.windowMs;
    const kept = arr.filter((ts) => ts > cutoff);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** True if this key is currently over its limit (no state change). */
  isLimited(key) {
    const t = this.now();
    return this.#prune(key, t).length >= this.max;
  }

  /** Record one failed attempt. Returns true if now over the limit. */
  recordFailure(key) {
    const t = this.now();
    const kept = this.#prune(key, t);
    kept.push(t);
    this.hits.set(key, kept);
    return kept.length >= this.max;
  }

  /** Clear a key's history (call on a successful join). */
  reset(key) {
    this.hits.delete(key);
  }

  /** How many ms until the key is allowed again (0 if not limited). */
  retryAfterMs(key) {
    const arr = this.hits.get(key);
    if (!arr || arr.length < this.max) return 0;
    const oldest = arr[arr.length - this.max];
    return Math.max(0, oldest + this.windowMs - this.now());
  }
}
