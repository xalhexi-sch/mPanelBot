class LinkRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  storeCode(code, steamId, playerName, serverId, ttlSeconds = 600) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    // One pending code per player: a new /link replaces the old one, so a flood of requests cannot fill the table.
    this.dbManager.prepare("DELETE FROM link_codes WHERE steam_id = ?").run(String(steamId).trim());

    const stmt = this.dbManager.prepare(`
      INSERT OR REPLACE INTO link_codes (code, steam_id, player_name, server_id, expires_at_utc, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      code.trim().toUpperCase(),
      String(steamId).trim(),
      String(playerName || "Unknown").trim(),
      String(serverId || "default").trim(),
      expiresAt.toISOString(),
      now.toISOString()
    );

    return {
      code: code.trim().toUpperCase(),
      expiresAtUtc: expiresAt.toISOString(),
    };
  }

  consumeCode(code) {
    const cleanCode = String(code || "").trim().toUpperCase();
    if (!cleanCode) return null;

    return this.dbManager.transaction((db) => {
      const getStmt = db.prepare("SELECT * FROM link_codes WHERE code = ?");
      const row = getStmt.get(cleanCode);
      if (!row) return null;

      const deleteStmt = db.prepare("DELETE FROM link_codes WHERE code = ?");
      deleteStmt.run(cleanCode);

      const now = new Date();
      const expiresAt = new Date(row.expires_at_utc);
      if (expiresAt <= now) {
        return null; // Expired
      }

      return {
        code: row.code,
        steamId: row.steam_id,
        playerName: row.player_name,
        serverId: row.server_id,
        createdAtUtc: row.created_at_utc,
      };
    });
  }

  purgeExpiredCodes() {
    const nowIso = new Date().toISOString();
    const stmt = this.dbManager.prepare("DELETE FROM link_codes WHERE expires_at_utc < ?");
    return stmt.run(nowIso);
  }

  linkAccount(steamId, discordId) {
    const sid = String(steamId).trim();
    const did = String(discordId).trim();
    const nowIso = new Date().toISOString();

    return this.dbManager.transaction((db) => {
      // Ensure 1:1 uniqueness: remove any existing link for this discord ID or steam ID
      db.prepare("DELETE FROM account_links WHERE steam_id = ? OR discord_id = ?").run(sid, did);

      db.prepare(`
        INSERT INTO account_links (steam_id, discord_id, raid_alerts_dm, linked_at)
        VALUES (?, ?, 1, ?)
      `).run(sid, did, nowIso);

      return { steamId: sid, discordId: did, linkedAt: nowIso };
    });
  }

  unlinkByDiscord(discordId) {
    const did = String(discordId).trim();
    const stmt = this.dbManager.prepare("DELETE FROM account_links WHERE discord_id = ?");
    const result = stmt.run(did);
    return result.changes > 0;
  }

  unlinkBySteam(steamId) {
    const sid = String(steamId).trim();
    const stmt = this.dbManager.prepare("DELETE FROM account_links WHERE steam_id = ?");
    const result = stmt.run(sid);
    return result.changes > 0;
  }

  getLinkByDiscord(discordId) {
    const did = String(discordId).trim();
    const stmt = this.dbManager.prepare("SELECT * FROM account_links WHERE discord_id = ?");
    return stmt.get(did) || null;
  }

  getLinkBySteam(steamId) {
    const sid = String(steamId).trim();
    const stmt = this.dbManager.prepare("SELECT * FROM account_links WHERE steam_id = ?");
    return stmt.get(sid) || null;
  }

  getAllLinks() {
    const stmt = this.dbManager.prepare("SELECT * FROM account_links");
    return stmt.all();
  }

  setRaidAlertsDm(discordId, enabled) {
    const did = String(discordId).trim();
    const val = enabled ? 1 : 0;
    const stmt = this.dbManager.prepare("UPDATE account_links SET raid_alerts_dm = ? WHERE discord_id = ?");
    const res = stmt.run(val, did);
    return res.changes > 0;
  }
}

module.exports = { LinkRepository };
