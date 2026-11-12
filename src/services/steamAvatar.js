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

const STEAM64_BASE = 76561197960265728n;

/**
 * Estimates Steam account creation timestamp (Unix epoch seconds) from Steam64 ID using historical ID registration milestones.
 * Sequential account allocation allows accurate approximation (~1-2 months) even when a profile is private.
 */
function estimateSteamAccountAge(steamId) {
  try {
    const sid = BigInt(String(steamId).trim());
    if (sid < STEAM64_BASE) return null;
    const accountId = Number(sid - STEAM64_BASE);
    if (accountId <= 0 || accountId > 3_000_000_000) return null;

    const milestones = [
      [0, 1063324800],          // Sep 12 2003 (Steam Launch)
      [1500000, 1072915200],    // Jan 01 2004
      [4500000, 1104537600],    // Jan 01 2005
      [8000000, 1136073600],    // Jan 01 2006
      [13000000, 1167609600],   // Jan 01 2007
      [19000000, 1199145600],   // Jan 01 2008
      [27000000, 1230768000],   // Jan 01 2009
      [39000000, 1262304000],   // Jan 01 2010
      [56000000, 1293840000],   // Jan 01 2011
      [82000000, 1325376000],   // Jan 01 2012
      [120000000, 1356998400],  // Jan 01 2013
      [170000000, 1388534400],  // Jan 01 2014
      [235000000, 1420070400],  // Jan 01 2015
      [320000000, 1451606400],  // Jan 01 2016
      [415000000, 1483228800],  // Jan 01 2017
      [525000000, 1514764800],  // Jan 01 2018
      [670000000, 1546300800],  // Jan 01 2019
      [830000000, 1577836800],  // Jan 01 2020
      [1000000000, 1609459200], // Jan 01 2021
      [1180000000, 1640995200], // Jan 01 2022
      [1350000000, 1672531200], // Jan 01 2023
      [1500000000, 1704067200], // Jan 01 2024
      [1650000000, 1735689600], // Jan 01 2025
      [1800000000, 1767225600], // Jan 01 2026
    ];

    if (accountId <= milestones[0][0]) return milestones[0][1];
    for (let i = 0; i < milestones.length - 1; i++) {
      const [idA, timeA] = milestones[i];
      const [idB, timeB] = milestones[i + 1];
      if (accountId >= idA && accountId <= idB) {
        const ratio = (accountId - idA) / (idB - idA);
        return Math.floor(timeA + ratio * (timeB - timeA));
      }
    }
    const last = milestones[milestones.length - 1];
    const prev = milestones[milestones.length - 2];
    const rate = (last[1] - prev[1]) / (last[0] - prev[0]);
    return Math.floor(last[1] + (accountId - last[0]) * rate);
  } catch {
    return null;
  }
}

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

  /** Fast HTTP request for official Steam Web API (not throttled by community XML 429 backoff). */
  async _api(url) {
    try {
      const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { "user-agent": "mPanelBot/1.0" } });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{avatarUrl:string|null, createdUnix:number|null, isEstimate?:boolean}>} */
  async getProfile(steamId) {
    const id = String(steamId || "").trim();
    const empty = { avatarUrl: null, createdUnix: null };
    if (!/^\d{17}$/.test(id)) return empty;
    const hit = this.profiles.get(id);
    if (hit && hit.expires > this.now()) return hit.value;

    return this._dedupe(`p:${id}`, async () => {
      let result = null;
      if (this.apiKey) {
        result = await this._profileViaApi(id);
      }
      if (!result || !result.avatarUrl) {
        const xmlResult = await this._profileViaXml(id);
        if (xmlResult) {
          result = {
            avatarUrl: xmlResult.avatarUrl || result?.avatarUrl || null,
            createdUnix: xmlResult.createdUnix || result?.createdUnix || null,
            isEstimate: false,
          };
        }
      }

      if (!result) {
        result = { avatarUrl: null, createdUnix: null };
      }

      return this._remember(this.profiles, id, result, result.avatarUrl ? OK_TTL_MS : FAIL_TTL_MS);
    });
  }

  /** Official Steam Web API GetPlayerSummaries (returns avatar even for private profiles). */
  async _profileViaApi(steamId) {
    const key = String(this.apiKey || "").trim();
    if (!key) return null;
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId)}`;
    const body = await this._api(url);
    if (!body) return null;
    try {
      const data = JSON.parse(body);
      const player = data?.response?.players?.[0];
      if (!player) return null;
      const avatar = player.avatarfull || player.avatarmedium || player.avatar || null;
      const created = player.timecreated ? Number(player.timecreated) : null;
      return {
        avatarUrl: /^https?:\/\//.test(avatar) ? avatar : null,
        createdUnix: created && !Number.isNaN(created) ? created : null,
        isEstimate: false,
      };
    } catch {
      return null;
    }
  }

  async _profileViaXml(id) {
    const xml = await this._xml(`https://steamcommunity.com/profiles/${id}?xml=1`);
    if (!xml) return null;
    const avatar = tag(xml, "avatarFull");
    const since = Date.parse(`${tag(xml, "memberSince")} UTC`);
    return {
      avatarUrl: /^https?:\/\//.test(avatar) ? avatar : null,
      createdUnix: Number.isNaN(since) ? null : Math.floor(since / 1000),
      isEstimate: false,
    };
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
    const key = String(this.apiKey || "").trim();
    if (!key) return null;
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(key)}&vanityurl=${encodeURIComponent(name)}`;
    const body = await this._api(url);
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

module.exports = { SteamAvatarService, estimateSteamAccountAge };
