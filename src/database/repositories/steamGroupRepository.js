/** Persistent cache of Steam group names so a successful lookup is never lost to a later rate limit or outage. */
class SteamGroupRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  get(groupId) {
    const row = this.dbManager.prepare("SELECT name, url, fetched_at_utc FROM steam_groups WHERE group_id = ?").get(String(groupId));
    if (!row) return null;
    return { name: row.name, url: row.url, fetchedAtMs: Date.parse(row.fetched_at_utc) || 0 };
  }

  set(groupId, { name, url }) {
    this.dbManager
      .prepare(
        `INSERT INTO steam_groups (group_id, name, url, fetched_at_utc) VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, url = excluded.url, fetched_at_utc = excluded.fetched_at_utc`
      )
      .run(String(groupId), String(name), url || null, new Date().toISOString());
  }
}

module.exports = { SteamGroupRepository };
