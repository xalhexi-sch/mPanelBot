const { encryptText, decryptText, isEncryptedWith } = require("../../utils/security");

// camelCase field -> SQLite column. Single source of truth so adding a setting is a one-line change.
const FIELD_COLUMNS = {
  raidChannelId: "raid_channel_id",
  chatChannelId: "chat_channel_id",
  chatWebhookUrl: "chat_webhook_url", // stored encrypted
  joinLeaveChannelId: "join_leave_channel_id",
  commandLogChannelId: "command_log_channel_id",
  punishmentLogChannelId: "punishment_log_channel_id",
  linkedRoleId: "linked_role_id",
  statusChannelId: "status_channel_id",
  statusMessageId: "status_message_id",
  leaderboardChannelId: "leaderboard_channel_id",
  leaderboardMessageId: "leaderboard_message_id",
  adminRoleIds: "admin_role_ids", // JSON array
};

class GuildRepository {
  /**
   * @param encryptionSecret current secret used to encrypt
   * @param legacySecrets older secrets that may still protect stored values (e.g. the API key used before a dedicated key existed)
   */
  constructor(dbManager, encryptionSecret, legacySecrets = []) {
    this.dbManager = dbManager;
    this.encryptionSecret = encryptionSecret;
    this.readSecrets = [encryptionSecret, ...legacySecrets].filter(Boolean);
  }

  /** Re-encrypts any value still protected by a legacy secret with the current one. Idempotent; call once at startup. */
  migrateEncryption() {
    let migrated = 0;
    const rows = this.dbManager.prepare("SELECT guild_id, chat_webhook_url FROM guild_configs WHERE chat_webhook_url IS NOT NULL").all();
    for (const row of rows) {
      if (isEncryptedWith(row.chat_webhook_url, this.encryptionSecret)) continue;
      const plain = decryptText(row.chat_webhook_url, this.readSecrets);
      if (!plain) continue;
      this.dbManager
        .prepare("UPDATE guild_configs SET chat_webhook_url = ? WHERE guild_id = ?")
        .run(encryptText(plain, this.encryptionSecret), row.guild_id);
      migrated++;
    }
    return migrated;
  }

  _rowToConfig(row) {
    let adminRoleIds = [];
    try {
      adminRoleIds = JSON.parse(row.admin_role_ids || "[]");
    } catch {
      adminRoleIds = [];
    }
    const cfg = { guildId: row.guild_id, adminRoleIds, updatedAt: row.updated_at };
    for (const [field, col] of Object.entries(FIELD_COLUMNS)) {
      if (field === "adminRoleIds") continue;
      cfg[field] = field === "chatWebhookUrl"
        ? decryptText(row[col], this.readSecrets) || null
        : row[col] || null;
    }
    return cfg;
  }

  getGuildConfig(guildId) {
    const row = this.dbManager.prepare("SELECT * FROM guild_configs WHERE guild_id = ?").get(String(guildId).trim());
    return row ? this._rowToConfig(row) : null;
  }

  upsertGuildConfig(guildId, updates = {}) {
    const gid = String(guildId).trim();
    const existing = this.getGuildConfig(gid) || { adminRoleIds: [] };
    const merged = { ...existing };
    for (const field of Object.keys(FIELD_COLUMNS)) {
      if (updates[field] !== undefined) merged[field] = updates[field];
    }
    merged.adminRoleIds = merged.adminRoleIds || [];
    merged.updatedAt = new Date().toISOString();

    const fields = Object.keys(FIELD_COLUMNS);
    const cols = fields.map((f) => FIELD_COLUMNS[f]);
    const values = fields.map((f) => {
      if (f === "adminRoleIds") return JSON.stringify(merged.adminRoleIds);
      if (f === "chatWebhookUrl") return encryptText(merged.chatWebhookUrl || null, this.encryptionSecret);
      return merged[f] ?? null;
    });

    this.dbManager
      .prepare(
        `INSERT INTO guild_configs (guild_id, ${cols.join(", ")}, updated_at)
         VALUES (?, ${cols.map(() => "?").join(", ")}, ?)
         ON CONFLICT(guild_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`
      )
      .run(gid, ...values, merged.updatedAt);

    return merged;
  }

  getAllGuildConfigs() {
    return this.dbManager.prepare("SELECT * FROM guild_configs").all().map((r) => this._rowToConfig(r));
  }
}

module.exports = { GuildRepository };
