/**
 * Resolves a player's Steam avatar URL from the public Steam Community profile XML (no API key needed).
 * Results are cached (bounded + TTL) and failures are negatively cached so a Steam outage never slows Discord delivery.
 */
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;

class SteamAvatarService {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = new Map(); // steamId -> { url|null, expires }
    this.pending = new Map();
  }

  /** @returns {Promise<string|null>} full-size avatar URL or null */
  async get(steamId) {
    const id = String(steamId || "").trim();
    if (!/^\d{17}$/.test(id)) return null;

    const hit = this.cache.get(id);
    if (hit && hit.expires > Date.now()) return hit.url;
    if (this.pending.has(id)) return this.pending.get(id);

    const p = this._lookup(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  async _lookup(id) {
    let url = null;
    try {
      const res = await this.fetch(`https://steamcommunity.com/profiles/${id}?xml=1`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const xml = await res.text();
        const m = xml.match(/<avatarFull><!\[CDATA\[(https?:\/\/[^\]]+)\]\]><\/avatarFull>/);
        url = m ? m[1] : null;
      }
    } catch {
      url = null;
    }

    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, { url, expires: Date.now() + (url ? OK_TTL_MS : FAIL_TTL_MS) });
    return url;
  }
}

module.exports = { SteamAvatarService };
