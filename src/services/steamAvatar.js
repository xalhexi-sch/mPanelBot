/**
 * Public Steam Community lookups (no API key): profile avatar, account creation date, and group names.
 * Everything is cached (bounded + TTL) and failures are negatively cached so a Steam outage never slows Discord delivery.
 */
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;

const tag = (xml, name) => {
  const re = new RegExp(String.raw`<${name}>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</${name}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
};

class SteamAvatarService {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.profiles = new Map(); // steamId -> { value, expires }
    this.groups = new Map(); // groupId -> { value, expires }
    this.pending = new Map();
  }

  async _xml(url) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  _remember(map, key, value, ok) {
    if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
    map.set(key, { value, expires: Date.now() + (ok ? OK_TTL_MS : FAIL_TTL_MS) });
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
    if (hit && hit.expires > Date.now()) return hit.value;

    return this._dedupe(`p:${id}`, async () => {
      try {
        const xml = await this._xml(`https://steamcommunity.com/profiles/${id}?xml=1`);
        const avatar = tag(xml, "avatarFull");
        const since = Date.parse(`${tag(xml, "memberSince")} UTC`);
        return this._remember(
          this.profiles,
          id,
          { avatarUrl: /^https?:\/\//.test(avatar) ? avatar : null, createdUnix: Number.isNaN(since) ? null : Math.floor(since / 1000) },
          Boolean(avatar)
        );
      } catch {
        return this._remember(this.profiles, id, empty, false);
      }
    });
  }

  /** Back-compat: just the avatar URL. */
  async get(steamId) {
    return (await this.getProfile(steamId)).avatarUrl;
  }

  /** Steam group name + url from its numeric gid. */
  async getGroup(groupId) {
    const id = String(groupId || "").trim();
    if (!/^\d{5,20}$/.test(id)) return null;
    const hit = this.groups.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;

    return this._dedupe(`g:${id}`, async () => {
      try {
        const xml = await this._xml(`https://steamcommunity.com/gid/${id}/memberslistxml/?xml=1`);
        const name = tag(xml, "groupName").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        const slug = tag(xml, "groupURL");
        const value = name ? { name, url: slug ? `https://steamcommunity.com/groups/${slug}` : `https://steamcommunity.com/gid/${id}` } : null;
        return this._remember(this.groups, id, value, Boolean(value));
      } catch {
        return this._remember(this.groups, id, null, false);
      }
    });
  }
}

module.exports = { SteamAvatarService };
