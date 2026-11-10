class StatsRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  recordKill(killerSteamId, killerName, victimSteamId, victimName, isHeadshot = false) {
    const kSid = String(killerSteamId).trim();
    const vSid = String(victimSteamId).trim();
    const kName = String(killerName || "Unknown").trim();
    const vName = String(victimName || "Unknown").trim();
    const nowIso = new Date().toISOString();
    const headshotInc = isHeadshot ? 1 : 0;

    return this.dbManager.transaction((db) => {
      // Upsert killer
      db.prepare(`
        INSERT INTO player_stats (steam_id, player_name, kills, deaths, headshots, playtime_seconds, last_seen_at_utc)
        VALUES (?, ?, 1, 0, ?, 0, ?)
        ON CONFLICT(steam_id) DO UPDATE SET
          kills = kills + 1,
          headshots = headshots + ?,
          player_name = excluded.player_name,
          last_seen_at_utc = excluded.last_seen_at_utc
      `).run(kSid, kName, headshotInc, nowIso, headshotInc);

      // Upsert victim
      db.prepare(`
        INSERT INTO player_stats (steam_id, player_name, kills, deaths, headshots, playtime_seconds, last_seen_at_utc)
        VALUES (?, ?, 0, 1, 0, 0, ?)
        ON CONFLICT(steam_id) DO UPDATE SET
          deaths = deaths + 1,
          player_name = excluded.player_name,
          last_seen_at_utc = excluded.last_seen_at_utc
      `).run(vSid, vName, nowIso);
    });
  }

  recordDeath(victimSteamId, victimName) {
    const vSid = String(victimSteamId).trim();
    const vName = String(victimName || "Unknown").trim();
    const nowIso = new Date().toISOString();

    const stmt = this.dbManager.prepare(`
      INSERT INTO player_stats (steam_id, player_name, kills, deaths, headshots, playtime_seconds, last_seen_at_utc)
      VALUES (?, ?, 0, 1, 0, 0, ?)
      ON CONFLICT(steam_id) DO UPDATE SET
        deaths = deaths + 1,
        player_name = excluded.player_name,
        last_seen_at_utc = excluded.last_seen_at_utc
    `);
    return stmt.run(vSid, vName, nowIso);
  }

  recordPlaytime(steamId, playerName, additionalSeconds) {
    const sid = String(steamId).trim();
    const name = String(playerName || "Unknown").trim();
    const secs = Math.max(0, parseInt(additionalSeconds, 10) || 0);
    const nowIso = new Date().toISOString();

    const stmt = this.dbManager.prepare(`
      INSERT INTO player_stats (steam_id, player_name, kills, deaths, headshots, playtime_seconds, last_seen_at_utc)
      VALUES (?, ?, 0, 0, 0, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET
        playtime_seconds = playtime_seconds + ?,
        player_name = excluded.player_name,
        last_seen_at_utc = excluded.last_seen_at_utc
    `);
    return stmt.run(sid, name, secs, nowIso, secs);
  }

  updatePlayerSeen(steamId, playerName) {
    const sid = String(steamId).trim();
    const name = String(playerName || "Unknown").trim();
    const nowIso = new Date().toISOString();

    const stmt = this.dbManager.prepare(`
      INSERT INTO player_stats (steam_id, player_name, kills, deaths, headshots, playtime_seconds, last_seen_at_utc)
      VALUES (?, ?, 0, 0, 0, 0, ?)
      ON CONFLICT(steam_id) DO UPDATE SET
        player_name = excluded.player_name,
        last_seen_at_utc = excluded.last_seen_at_utc
    `);
    return stmt.run(sid, name, nowIso);
  }

  getStats(steamId) {
    const sid = String(steamId).trim();
    const stmt = this.dbManager.prepare("SELECT * FROM player_stats WHERE steam_id = ?");
    const row = stmt.get(sid);
    if (!row) return null;

    const kills = row.kills || 0;
    const deaths = row.deaths || 0;
    const kd = deaths === 0 ? kills : (kills / deaths).toFixed(2);

    return {
      steamId: row.steam_id,
      playerName: row.player_name,
      kills,
      deaths,
      kd: Number(kd),
      headshots: row.headshots || 0,
      playtimeSeconds: row.playtime_seconds || 0,
      lastSeenAtUtc: row.last_seen_at_utc,
    };
  }

  getTopKills(limit = 10) {
    const stmt = this.dbManager.prepare(`
      SELECT steam_id, player_name, kills, deaths, headshots, playtime_seconds
      FROM player_stats
      ORDER BY kills DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getTopPlaytime(limit = 10) {
    const stmt = this.dbManager.prepare(`
      SELECT steam_id, player_name, kills, deaths, headshots, playtime_seconds
      FROM player_stats
      ORDER BY playtime_seconds DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }

  getTopDeaths(limit = 10) {
    const stmt = this.dbManager.prepare(`
      SELECT steam_id, player_name, kills, deaths, headshots, playtime_seconds
      FROM player_stats
      ORDER BY deaths DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }
}

module.exports = { StatsRepository };
