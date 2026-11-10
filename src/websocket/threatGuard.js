/**
 * Abuse protection primitives for the public WebSocket port.
 * Everything here is O(1) per call with hard memory bounds, so an attacker cannot make the guard itself expensive.
 */

/**
 * Per-address failed-login throttle. After `maxFailures` bad attempts inside `windowMs` the address is blocked
 * for `blockMs`. A successful login clears the counter. Entries are bounded (oldest evicted first).
 */
class AuthThrottle {
  constructor({ maxFailures = 5, windowMs = 60_000, blockMs = 5 * 60_000, maxEntries = 5000, now = Date.now } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map(); // address -> { failures, firstAt, blockedUntil }
  }

  /** @returns {number} milliseconds the address stays blocked (0 = allowed) */
  blockedFor(address) {
    const e = this.entries.get(address);
    if (!e || !e.blockedUntil) return 0;
    const left = e.blockedUntil - this.now();
    if (left <= 0) {
      this.entries.delete(address);
      return 0;
    }
    return left;
  }

  recordFailure(address) {
    const t = this.now();
    let e = this.entries.get(address);
    if (!e || t - e.firstAt > this.windowMs) {
      e = { failures: 0, firstAt: t, blockedUntil: 0 };
    }
    e.failures++;
    if (e.failures >= this.maxFailures) e.blockedUntil = t + this.blockMs;

    // Re-insert so Map order tracks recency, then enforce the bound
    this.entries.delete(address);
    this.entries.set(address, e);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return e.blockedUntil > 0;
  }

  recordSuccess(address) {
    this.entries.delete(address);
  }
}

/** Token bucket: `ratePerSec` sustained, `burst` short spikes. One instance per connection. */
class TokenBucket {
  constructor({ ratePerSec = 40, burst = 200, now = Date.now } = {}) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  take(count = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

module.exports = { AuthThrottle, TokenBucket };
