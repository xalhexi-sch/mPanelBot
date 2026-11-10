const crypto = require("node:crypto");

class AuditRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  recordAudit({
    id = crypto.randomUUID(),
    serverId,
    commandName,
    fullCommand,
    targetSteamId = null,
    requestedByDiscordId,
    requestedByTag = null,
    executedVia, // "websocket" | "pterodactyl"
    success,
    resultMessage = null,
  }) {
    const nowIso = new Date().toISOString();
    const stmt = this.dbManager.prepare(`
      INSERT INTO command_audits (
        id, server_id, command_name, full_command, target_steam_id,
        requested_by_discord_id, requested_by_tag, executed_via,
        success, result_message, created_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      String(serverId || "unknown"),
      String(commandName || "unknown"),
      String(fullCommand || "").slice(0, 1000),
      targetSteamId ? String(targetSteamId) : null,
      String(requestedByDiscordId),
      requestedByTag ? String(requestedByTag).slice(0, 100) : null,
      String(executedVia || "websocket"),
      success ? 1 : 0,
      resultMessage ? String(resultMessage).slice(0, 1000) : null,
      nowIso
    );

    return { id, createdAtUtc: nowIso };
  }

  getRecentAudits(limit = 20) {
    const stmt = this.dbManager.prepare(`
      SELECT * FROM command_audits
      ORDER BY created_at_utc DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  }
}

module.exports = { AuditRepository };
