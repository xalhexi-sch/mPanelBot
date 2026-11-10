class GuildRepository {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  getGuildConfig(guildId) {
    const gid = String(guildId).trim();
    const stmt = this.dbManager.prepare("SELECT * FROM guild_configs WHERE guild_id = ?");
    const row = stmt.get(gid);
    if (!row) return null;

    let adminRoleIds = [];
    try {
      adminRoleIds = JSON.parse(row.admin_role_ids || "[]");
    } catch {
      adminRoleIds = [];
    }

    return {
      guildId: row.guild_id,
      raidChannelId: row.raid_channel_id || null,
      chatChannelId: row.chat_channel_id || null,
      joinLeaveChannelId: row.join_leave_channel_id || null,
      commandLogChannelId: row.command_log_channel_id || null,
      punishmentLogChannelId: row.punishment_log_channel_id || null,
      linkedRoleId: row.linked_role_id || null,
      adminRoleIds,
      updatedAt: row.updated_at,
    };
  }

  upsertGuildConfig(guildId, updates = {}) {
    const gid = String(guildId).trim();
    const existing = this.getGuildConfig(gid) || {
      raidChannelId: null,
      chatChannelId: null,
      joinLeaveChannelId: null,
      commandLogChannelId: null,
      punishmentLogChannelId: null,
      linkedRoleId: null,
      adminRoleIds: [],
    };

    const finalConfig = {
      raidChannelId: updates.raidChannelId !== undefined ? updates.raidChannelId : existing.raidChannelId,
      chatChannelId: updates.chatChannelId !== undefined ? updates.chatChannelId : existing.chatChannelId,
      joinLeaveChannelId: updates.joinLeaveChannelId !== undefined ? updates.joinLeaveChannelId : existing.joinLeaveChannelId,
      commandLogChannelId: updates.commandLogChannelId !== undefined ? updates.commandLogChannelId : existing.commandLogChannelId,
      punishmentLogChannelId: updates.punishmentLogChannelId !== undefined ? updates.punishmentLogChannelId : existing.punishmentLogChannelId,
      linkedRoleId: updates.linkedRoleId !== undefined ? updates.linkedRoleId : existing.linkedRoleId,
      adminRoleIds: updates.adminRoleIds !== undefined ? updates.adminRoleIds : existing.adminRoleIds,
      updatedAt: new Date().toISOString(),
    };

    const stmt = this.dbManager.prepare(`
      INSERT INTO guild_configs (
        guild_id, raid_channel_id, chat_channel_id, join_leave_channel_id,
        command_log_channel_id, punishment_log_channel_id, linked_role_id,
        admin_role_ids, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        raid_channel_id = excluded.raid_channel_id,
        chat_channel_id = excluded.chat_channel_id,
        join_leave_channel_id = excluded.join_leave_channel_id,
        command_log_channel_id = excluded.command_log_channel_id,
        punishment_log_channel_id = excluded.punishment_log_channel_id,
        linked_role_id = excluded.linked_role_id,
        admin_role_ids = excluded.admin_role_ids,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      gid,
      finalConfig.raidChannelId,
      finalConfig.chatChannelId,
      finalConfig.joinLeaveChannelId,
      finalConfig.commandLogChannelId,
      finalConfig.punishmentLogChannelId,
      finalConfig.linkedRoleId,
      JSON.stringify(finalConfig.adminRoleIds),
      finalConfig.updatedAt
    );

    return finalConfig;
  }

  getAllGuildConfigs() {
    const stmt = this.dbManager.prepare("SELECT * FROM guild_configs");
    const rows = stmt.all();
    return rows.map((row) => {
      let adminRoleIds = [];
      try {
        adminRoleIds = JSON.parse(row.admin_role_ids || "[]");
      } catch {}
      return {
        guildId: row.guild_id,
        raidChannelId: row.raid_channel_id || null,
        chatChannelId: row.chat_channel_id || null,
        joinLeaveChannelId: row.join_leave_channel_id || null,
        commandLogChannelId: row.command_log_channel_id || null,
        punishmentLogChannelId: row.punishment_log_channel_id || null,
        linkedRoleId: row.linked_role_id || null,
        adminRoleIds,
        updatedAt: row.updated_at,
      };
    });
  }
}

module.exports = { GuildRepository };
