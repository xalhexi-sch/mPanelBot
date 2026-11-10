class RoleSyncManager {
  constructor({ linkRepo, guildRepo, discordClient }) {
    this.linkRepo = linkRepo;
    this.guildRepo = guildRepo;
    this.discordClient = discordClient;
  }

  isMemberLinked(discordId) {
    return Boolean(this.linkRepo.getLinkByDiscord(discordId));
  }

  determineRoleSyncAction(isLinked, hasRole) {
    if (isLinked && !hasRole) {
      return "ADD";
    }
    if (!isLinked && hasRole) {
      return "REMOVE";
    }
    return "NOOP";
  }

  async syncMember(member) {
    if (!member || !member.guild || member.user.bot) return "NOOP";

    const guildConfig = this.guildRepo.getGuildConfig(member.guild.id);
    const linkedRoleId = guildConfig?.linkedRoleId;
    if (!linkedRoleId) return "NOOP";

    const isLinked = this.isMemberLinked(member.id);
    const hasRole = member.roles.cache.has(linkedRoleId);
    const action = this.determineRoleSyncAction(isLinked, hasRole);

    try {
      if (action === "ADD") {
        await member.roles.add(linkedRoleId, "Account linked to Steam");
        return "ADDED";
      } else if (action === "REMOVE") {
        await member.roles.remove(linkedRoleId, "Account unlinked");
        return "REMOVED";
      }
    } catch (err) {
      console.warn(`[roleSync] Failed to update role for member ${member.id} in guild ${member.guild.id}: ${err.message}`);
      return "ERROR";
    }

    return "NOOP";
  }

  async syncGuild(guild) {
    if (!guild) return { synced: 0, added: 0, removed: 0 };

    const guildConfig = this.guildRepo.getGuildConfig(guild.id);
    if (!guildConfig?.linkedRoleId) {
      return { synced: 0, added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;
    let synced = 0;

    try {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (member.user.bot) continue;
        const res = await this.syncMember(member);
        synced++;
        if (res === "ADDED") added++;
        if (res === "REMOVED") removed++;
      }
    } catch (err) {
      console.warn(`[roleSync] Error syncing guild ${guild.id}: ${err.message}`);
    }

    return { synced, added, removed };
  }
}

module.exports = { RoleSyncManager };
