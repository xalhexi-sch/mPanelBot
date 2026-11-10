class SnapshotRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  saveSnapshot(serverId, snapshot) {
    const sid = String(serverId).trim();
    const serverName = String(snapshot.serverName || "Unturned Server").trim();
    const map = String(snapshot.map || "").trim();
    const onlineCount = Number(snapshot.onlineCount ?? snapshot.onlinePlayers ?? (snapshot.players ? snapshot.players.length : 0)) || 0;
    const maxPlayers = Number(snapshot.maxPlayers || 0);
    const playersJson = JSON.stringify(Array.isArray(snapshot.players) ? snapshot.players : []);
    const nowIso = new Date().toISOString();

    const stmt = this.dbManager.prepare(`
      INSERT INTO server_snapshots (server_id, server_name, server_steam_id, map, online_count, max_players, players_json, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        server_name = excluded.server_name,
        server_steam_id = excluded.server_steam_id,
        map = excluded.map,
        online_count = excluded.online_count,
        max_players = excluded.max_players,
        players_json = excluded.players_json,
        updated_at_utc = excluded.updated_at_utc
    `);

    stmt.run(sid, serverName, String(snapshot.serverSteamId || "") || null, map, onlineCount, maxPlayers, playersJson, nowIso);

    return {
      serverId: sid,
      serverName,
      serverSteamId: String(snapshot.serverSteamId || "") || null,
      map,
      onlineCount,
      maxPlayers,
      players: Array.isArray(snapshot.players) ? snapshot.players : [],
      updatedAtUtc: nowIso,
    };
  }

  getSnapshot(serverId) {
    const sid = String(serverId).trim();
    const stmt = this.dbManager.prepare("SELECT * FROM server_snapshots WHERE server_id = ?");
    const row = stmt.get(sid);
    if (!row) return null;

    let players = [];
    try {
      players = JSON.parse(row.players_json || "[]");
    } catch {}

    return {
      serverId: row.server_id,
      serverName: row.server_name,
      serverSteamId: row.server_steam_id || null,
      map: row.map,
      onlineCount: row.online_count,
      maxPlayers: row.max_players,
      players,
      updatedAtUtc: row.updated_at_utc,
    };
  }

  getAllSnapshots() {
    const stmt = this.dbManager.prepare("SELECT * FROM server_snapshots");
    const rows = stmt.all();
    return rows.map((row) => {
      let players = [];
      try {
        players = JSON.parse(row.players_json || "[]");
      } catch {}
      return {
        serverId: row.server_id,
        serverName: row.server_name,
        serverSteamId: row.server_steam_id || null,
        map: row.map,
        onlineCount: row.online_count,
        maxPlayers: row.max_players,
        players,
        updatedAtUtc: row.updated_at_utc,
      };
    });
  }
}

module.exports = { SnapshotRepository };
