/**
 * Pins the bot to the operator's own guild(s).
 *
 * Without this, anyone who can invite the bot (the invite URL is public if "Public Bot" is on) could run
 * /setup in their own server and receive every game chat line / log, or run console commands as a guild admin.
 *
 * Sources of truth, merged:
 *  1. `discord.guildIds` in config.json
 *  2. guilds persisted in SQLite `settings.allowed_guilds`
 *  3. trust-on-first-use: while nothing is pinned, the first Administrator to run /setup pins their guild.
 *     Existing installs are migrated by pinning every guild that already has a saved configuration.
 */
const SETTINGS_KEY = "allowed_guilds";

class GuildPolicy {
  constructor({ dbManager, guildRepo, configuredIds = [] }) {
    this.dbManager = dbManager;
    this.configured = new Set((configuredIds || []).map(String).filter((id) => /^\d{5,25}$/.test(id)));
    this.pinned = new Set();
    this._load();

    if (this.configured.size === 0 && this.pinned.size === 0 && guildRepo) {
      try {
        for (const c of guildRepo.getAllGuildConfigs()) this.pinned.add(String(c.guildId));
        if (this.pinned.size > 0) this._save();
      } catch {}
    }
  }

  _load() {
    try {
      const row = this.dbManager.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
      const ids = row ? JSON.parse(row.value) : [];
      if (Array.isArray(ids)) for (const id of ids) this.pinned.add(String(id));
    } catch {}
  }

  _save() {
    this.dbManager
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify([...this.pinned]));
  }

  /** True while no guild has been claimed yet (only /setup is then allowed anywhere). */
  get isUnclaimed() {
    return this.configured.size === 0 && this.pinned.size === 0;
  }

  isAllowed(guildId) {
    if (!guildId) return false;
    const id = String(guildId);
    return this.configured.has(id) || this.pinned.has(id);
  }

  /** Claims `guildId` if nothing is pinned yet. Returns true when the guild is (now) allowed. */
  claimIfUnclaimed(guildId) {
    if (this.isAllowed(guildId)) return true;
    if (!this.isUnclaimed || !guildId) return false;
    this.pinned.add(String(guildId));
    this._save();
    return true;
  }
}

module.exports = { GuildPolicy };
