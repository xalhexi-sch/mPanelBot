/**
 * Public Steam Community lookups (no API key): profile avatar, account creation date, group names, vanity -> Steam64.
 *
 * Steam rate-limits anonymous community requests per IP (HTTP 429), so this service is deliberately polite:
 *  - requests are spaced out (`minGapMs`) and run one at a time,
 *  - a 429 pauses ALL lookups until the Retry-After time (no hammering while blocked),
 *  - results are cached in memory, group names are additionally persisted via `groupStore` so a name that was
 *    ever fetched is never lost to a later outage,
 *  - failures are negatively cached briefly, and nothing here can throw into Discord delivery.
 */
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const GROUP_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 2 * 60 * 1000;
const DEFAULT_BACKOFF_MS = 90 * 1000;
const MAX_ENTRIES = 2000;

const tag = (xml, name) => {
  const re = new RegExp(String.raw`<${name}>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</${name}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
};

class SteamAvatarService {
  /**
   * @param groupStore optional `{ get(id) -> {name,url,fetchedAtMs}|null, set(id, {name,url}) }`
   */
  constructor({
    fetchImpl = globalThis.fetch,
    timeoutMs = 4000,
    minGapMs = 1200,
    groupStore = null,
    apiKey = "",
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.minGapMs = minGapMs;
    this.groupStore = groupStore;
    this.apiKey = apiKey;
    this.now = now;
    this.sleep = sleep;
    this.profiles = new Map(); // steamId -> { value, expires }
    this.groups = new Map(); // groupId -> { value, expires }
    this.vanities = new Map(); // vanity -> { value, expires }
    this.pending = new Map();
    this.chain = Promise.resolve(); // serialises network calls
    this.lastRequestAt = 0;
    this.blockedUntil = 0;
  }

  /** Milliseconds until Steam lookups are allowed again after a 429 (0 = not blocked). */
  get blockedForMs() {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** One polite, serialised request. Resolves to the response body text, or null on any failure / while blocked. */
  _xml(url) {
    const run = async () => {
      if (this.blockedForMs > 0) return null;
      const wait = this.lastRequestAt + this.minGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      try {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { "user-agent": "Mozilla/5.0" } });
        if (res.status === 429) {
          const retryAfter = Number(res.headers?.get?.("retry-after"));
          this.blockedUntil = this.now() + (retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS);
          return null;
        }
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  _remember(map, key, value, ttl) {
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
    map.set(key, { value, expires: this.now() + ttl });
    return value;
  }

  _dedupe(key, fn) {
    if (this.pending.has(key)) return this.pending.get(key);
    const p = fn().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** @returns {Promise<{avatarUrl:string|null, createdUnix:number|null}>} */
  async getProfile(steamId) {
    const id = String(steamId || "").trim();
    const empty = { avatarUrl: null, createdUnix: null };
    if (!/^\d{17}$/.test(id)) return empty;
    const hit = this.profiles.get(id);
    if (hit && hit.expires > this.now()) return hit.value;

    return this._dedupe(`p:${id}`, async () => {
      const xml = await this._xml(`https://steamcommunity.com/profiles/${id}?xml=1`);
      if (!xml) return this._remember(this.profiles, id, empty, FAIL_TTL_MS);
      const avatar = tag(xml, "avatarFull");
      const since = Date.parse(`${tag(xml, "memberSince")} UTC`);
      const value = {
        avatarUrl: /^https?:\/\//.test(avatar) ? avatar : null,
        createdUnix: Number.isNaN(since) ? null : Math.floor(since / 1000),
      };
      return this._remember(this.profiles, id, value, value.avatarUrl ? OK_TTL_MS : FAIL_TTL_MS);
    });
  }

  /**
   * Resolve a vanity name (steamcommunity.com/id/<vanity>) to a Steam64 ID via the public XML profile (no API key).
   * Shares the throttling / 429 backoff / caching of every other lookup. Definitive "no such profile" answers are
   * cached like successes; outages are only negatively cached briefly.
   * @returns {Promise<string|null>}
   */
  async resolveVanity(vanity) {
    const name = String(vanity || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,64}$/.test(name)) return null;
    const hit = this.vanities.get(name);
    if (hit && hit.expires > this.now()) return hit.value;

    return this._dedupe(`v:${name}`, async () => {
      const value = (await this._vanityViaApi(name)) || (await this._vanityViaXml(name)) || (await this._vanityViaHtml(name));
      return this._remember(this.vanities, name, value, value ? OK_TTL_MS : FAIL_TTL_MS);
    });
  }

  /** Steam Web API ResolveVanityURL; needs STEAM_API_KEY (constructor `apiKey` or env). */
  async _vanityViaApi(name) {
    const key = String(this.apiKey || process.env.STEAM_API_KEY || "").trim();
    if (!key) return null;
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(name)}`;
    const body = await this._xml(url);
    if (!body) return null;
    try {
      const r = JSON.parse(body)?.response;
      return r?.success === 1 && /^\d{17}$/.test(String(r.steamid)) ? String(r.steamid) : null;
    } catch {
      return null;
    }
  }

  async _vanityViaXml(name) {
    const xml = await this._xml(`https://steamcommunity.com/id/${name}?xml=1`);
    const id = xml ? tag(xml, "steamID64") : "";
    return /^\d{17}$/.test(id) ? id : null;
  }

  async _vanityViaHtml(name) {
    const html = await this._xml(`https://steamcommunity.com/id/${name}`);
    const m = html?.match(/"steamid"\s*:\s*"(\d{17})"/i);
    return m ? m[1] : null;
  }

  /** Back-compat: just the avatar URL. */
  async get(steamId) {
    return (await this.getProfile(steamId)).avatarUrl;
  }

  /**
   * Steam group name + url from its numeric gid. A persisted name is served even when stale if Steam is unreachable.
   * @returns {Promise<{name:string,url:string}|null>}
   */
  async getGroup(groupId) {
    const id = String(groupId || "").trim();
    if (!/^\d{5,20}$/.test(id)) return null;

    const mem = this.groups.get(id);
    if (mem && mem.expires > this.now()) return mem.value;

    const stored = this.groupStore?.get(id) || null;
    if (stored && this.now() - stored.fetchedAtMs < GROUP_REFRESH_MS) {
      return this._remember(this.groups, id, { name: stored.name, url: stored.url }, OK_TTL_MS);
    }

    return this._dedupe(`g:${id}`, async () => {
      const xml = await this._xml(`https://steamcommunity.com/gid/${id}/memberslistxml/?xml=1`);
      const name = xml ? tag(xml, "groupName").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
      if (name) {
        const slug = tag(xml, "groupURL");
        const value = { name, url: slug ? `https://steamcommunity.com/groups/${slug}` : `https://steamcommunity.com/gid/${id}` };
        try {
          this.groupStore?.set(id, value);
        } catch {}
        return this._remember(this.groups, id, value, OK_TTL_MS);
      }
      // Lookup failed: keep serving an old stored name rather than nothing; otherwise try again soon
      const fallback = stored ? { name: stored.name, url: stored.url } : null;
      return this._remember(this.groups, id, fallback, FAIL_TTL_MS);
    });
  }
}

module.exports = { SteamAvatarService };
