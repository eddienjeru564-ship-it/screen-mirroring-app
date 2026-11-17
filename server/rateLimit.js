// rateLimit.js — limits failed join-code attempts per client IP.
//
// Fixed window kept in the session store, so it works across serverless
// instances: the first failure starts a window of `windowMs`; once `max`
// failures land inside it, further attempts are refused until it expires.
// Only *failed* attempts count, and a successful join clears the counter, so a
// viewer who types the right code is never slowed down.

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {object} opts.store     MemoryStore or UpstashStore
   * @param {number} opts.max       max failed attempts per window
   * @param {number} opts.windowMs  window length in ms
   */
  constructor({ store, max = 5, windowMs = 60_000 }) {
    this.store = store;
    this.max = max;
    this.windowMs = windowMs;
  }

  #key(ip) {
    return `sv:rl:${ip}`;
  }

  /** True if this IP is currently over its limit (no state change). */
  async isLimited(ip) {
    return Number((await this.store.get(this.#key(ip))) || 0) >= this.max;
  }

  /** Record one failed attempt. Returns true if now at/over the limit. */
  async recordFailure(ip) {
    return (await this.store.incr(this.#key(ip), this.windowMs)) >= this.max;
  }

  /** Clear an IP's failures (call on a successful join). */
  async reset(ip) {
    await this.store.del(this.#key(ip));
  }

  /** How many ms until the IP may try again (0 if not limited). */
  async retryAfterMs(ip) {
    if (!(await this.isLimited(ip))) return 0;
    return Math.max(0, await this.store.pttl(this.#key(ip)));
  }
}
