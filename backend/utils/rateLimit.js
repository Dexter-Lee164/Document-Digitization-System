'use strict';

/** Minimal in-memory sliding-window limiter (enough for a single local server process). */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  _prune(key, now) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }

  /** True when the key has already used up its attempts. */
  blocked(key, now = Date.now()) {
    return this._prune(key, now).length >= this.max;
  }

  hit(key, now = Date.now()) {
    const list = this._prune(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = { RateLimiter };
