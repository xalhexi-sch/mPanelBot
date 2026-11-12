/**
 * Keeps Rocket/MySQL PermissionGroupMembers in sync with Discord account_links.
 *
 * Why SQL instead of /padd|/premove over WebSocket:
 * - Idempotent (EXISTS checks) — no command spam or console hiccups
 * - Works even when the game session is briefly down
 * - Plugin allowlist currently has paddbulk, not padd/premove
 *
 * Only manages ONE configured GroupId (e.g. "linked"). Other ranks are left alone.
 * ExpireDate is left NULL = permanent.
 */

const IDENT = /^[A-Za-z0-9_]{1,64}$/;

function ident(value, label) {
  if (!IDENT.test(String(value || ""))) {
    throw new Error(`Invalid MySQL ${label}: only letters, digits and _ are allowed.`);
  }
  return `\`${value}\``;
}

function loadLinkedPermissionConfig(raw = {}, mysqlEnabled = false) {
  const c = raw || {};
  const groupId = String(c.groupId || "").trim();
  const enabled = Boolean(c.enabled) && mysqlEnabled && Boolean(groupId);
  return {
    enabled,
    groupId,
    serverGroup: String(c.serverGroup || "PVP").trim() || "PVP",
    table: String(c.table || "PermissionGroupMembers").trim() || "PermissionGroupMembers",
    reconcileIntervalMs: Math.max(60_000, Number(c.reconcileIntervalMs) || 5 * 60_000),
  };
}

class LinkedPermissionSync {
  constructor({
    mysqlConfig,
    linkedConfig,
    linkRepo,
    mysqlModule = null,
    logger = console,
    now = () => new Date(),
  }) {
    this.linkRepo = linkRepo;
    this.logger = logger;
    this.now = now;
    this.cfg = loadLinkedPermissionConfig(linkedConfig, Boolean(mysqlConfig?.enabled));
    this.pool = null;
    this._reconciling = false;
    this._timer = null;
    this._table = null;

    if (!this.cfg.enabled) return;

    try {
      this._table = ident(this.cfg.table, "linkedPermission.table");
    } catch (err) {
      this.logger.warn(`[linkedPerm] Disabled: ${err.message}`);
      this.cfg.enabled = false;
      return;
    }

    const mysql = mysqlModule || require("mysql2/promise");
    this.pool = mysql.createPool({
      host: mysqlConfig.host,
      port: mysqlConfig.port,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      database: mysqlConfig.database,
      connectionLimit: 2,
      connectTimeout: 5000,
      waitForConnections: true,
      queueLimit: 20,
    });
  }

  get enabled() {
    return Boolean(this.cfg?.enabled && this.pool);
  }

  async ensureMember(steamId, { quiet = false, reason = "link" } = {}) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    const sid = String(steamId || "").trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, reason: "bad_steam" };

    try {
      const [existing] = await this.pool.execute(
        `SELECT Id FROM ${this._table} WHERE GroupId = ? AND SteamID = ? AND ServerGroup = ? LIMIT 1`,
        [this.cfg.groupId, sid, this.cfg.serverGroup]
      );
      if (existing.length > 0) return { ok: true, action: "noop" };

      const createDate = this._sqlNow();
      await this.pool.execute(
        `INSERT INTO ${this._table} (GroupId, SteamID, CreateDate, ExpireDate, ServerGroup) VALUES (?, ?, ?, NULL, ?)`,
        [this.cfg.groupId, sid, createDate, this.cfg.serverGroup]
      );
      if (!quiet) {
        this.logger.log(
          `[linkedPerm] + ${sid} -> ${this.cfg.groupId}/${this.cfg.serverGroup} (${reason})`
        );
      }
      return { ok: true, action: "added" };
    } catch (err) {
      this.logger.warn(`[linkedPerm] ensureMember failed for ${sid}: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  async removeMember(steamId, { quiet = false, reason = "unlink" } = {}) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    const sid = String(steamId || "").trim();
    if (!/^\d{17}$/.test(sid)) return { ok: false, reason: "bad_steam" };

    try {
      const [result] = await this.pool.execute(
        `DELETE FROM ${this._table} WHERE GroupId = ? AND SteamID = ? AND ServerGroup = ?`,
        [this.cfg.groupId, sid, this.cfg.serverGroup]
      );
      const removed = Number(result?.affectedRows || 0);
      if (removed > 0 && !quiet) {
        this.logger.log(
          `[linkedPerm] - ${sid} <- ${this.cfg.groupId}/${this.cfg.serverGroup} (${reason})`
        );
      }
      return { ok: true, action: removed > 0 ? "removed" : "noop", removed };
    } catch (err) {
      this.logger.warn(`[linkedPerm] removeMember failed for ${sid}: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Diff SQLite account_links vs MySQL group members for the configured GroupId only.
   * Adds missing linked players; removes group rows whose SteamID is no longer linked.
   */
  async reconcile() {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    if (this._reconciling) return { ok: true, skipped: true };
    this._reconciling = true;

    try {
      const linked = new Set(
        (this.linkRepo.getAllLinks() || [])
          .map((r) => String(r.steam_id || "").trim())
          .filter((s) => /^\d{17}$/.test(s))
      );

      const [rows] = await this.pool.execute(
        `SELECT CAST(SteamID AS CHAR) AS steamId FROM ${this._table} WHERE GroupId = ? AND ServerGroup = ?`,
        [this.cfg.groupId, this.cfg.serverGroup]
      );
      const inGroup = new Set((rows || []).map((r) => String(r.steamId || "").trim()).filter(Boolean));

      let added = 0;
      let removed = 0;
      let errors = 0;

      for (const sid of linked) {
        if (inGroup.has(sid)) continue;
        const res = await this.ensureMember(sid, { quiet: true, reason: "reconcile" });
        if (res.action === "added") added++;
        else if (!res.ok) errors++;
      }

      for (const sid of inGroup) {
        if (linked.has(sid)) continue;
        const res = await this.removeMember(sid, { quiet: true, reason: "reconcile" });
        if (res.action === "removed") removed++;
        else if (!res.ok) errors++;
      }

      if (added || removed || errors) {
        this.logger.log(
          `[linkedPerm] Reconcile group=${this.cfg.groupId}/${this.cfg.serverGroup}: +${added} -${removed}` +
            (errors ? ` errors=${errors}` : "")
        );
      }

      return { ok: true, added, removed, errors, linked: linked.size, inGroup: inGroup.size };
    } catch (err) {
      this.logger.warn(`[linkedPerm] Reconcile failed: ${err.message}`);
      return { ok: false, reason: err.message };
    } finally {
      this._reconciling = false;
    }
  }

  startPeriodicReconcile() {
    if (!this.enabled || this._timer) return;
    // First pass shortly after boot (links may already exist in SQLite).
    setTimeout(() => {
      this.reconcile().catch(() => {});
    }, 15_000).unref?.();

    this._timer = setInterval(() => {
      this.reconcile().catch(() => {});
    }, this.cfg.reconcileIntervalMs);
    this._timer.unref?.();
  }

  async close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }
  }

  _sqlNow() {
    const d = this.now();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }
}

module.exports = { LinkedPermissionSync, loadLinkedPermissionConfig };
