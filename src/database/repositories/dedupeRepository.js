class DedupeRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  isEventProcessed(serverId, eventId) {
    const sid = String(serverId).trim();
    const eid = String(eventId).trim();
    const stmt = this.dbManager.prepare(
      "SELECT 1 FROM processed_events WHERE server_id = ? AND event_id = ?"
    );
    const row = stmt.get(sid, eid);
    return Boolean(row);
  }

  markEventProcessed(serverId, eventId, eventType) {
    const sid = String(serverId).trim();
    const eid = String(eventId).trim();
    const type = String(eventType || "unknown").trim();
    const nowIso = new Date().toISOString();

    const stmt = this.dbManager.prepare(`
      INSERT OR IGNORE INTO processed_events (server_id, event_id, event_type, processed_at_utc)
      VALUES (?, ?, ?, ?)
    `);
    const res = stmt.run(sid, eid, type, nowIso);
    return res.changes > 0;
  }

  pruneOldEvents(maxAgeDays = 7) {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();
    const stmt = this.dbManager.prepare("DELETE FROM processed_events WHERE processed_at_utc < ?");
    return stmt.run(cutoff);
  }
}

module.exports = { DedupeRepository };
