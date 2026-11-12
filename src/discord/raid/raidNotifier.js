const { buildRaidAlertEmbed } = require("../views");

class RaidNotifier {
  constructor({ discordClient, linkRepo, guildRepo, showRaider = true }) {
    this.showRaider = Boolean(showRaider);
    this.client = discordClient;
    this.linkRepo = linkRepo;
    this.guildRepo = guildRepo;
    this.recentAlerts = new Map(); // key -> timestamp
  }

  buildRaidEmbed(alert, isFinished = false) {
    return buildRaidAlertEmbed(alert, { isFinished, showRaider: this.showRaider });
  }

  async handleRaidAlert(alert) {
    const ownerSid = alert.ownerSteamId || alert.steamId;
    const attackerSid = alert.attackerSteamId || alert.destroyerSteamId;

    const objName = String(alert.objectName || "").trim().toLowerCase();
    const weapon = String(alert.weapon || alert.weaponName || "").trim().toLowerCase();
    const isCharge = objName === "c4" || objName.includes("charge");
    const isDetonator = weapon.includes("detonat");

    // Self-destruction or friendly fire is not a raid (allow charges broken by non-detonator attacks for solo testing)
    if (attackerSid && ownerSid && String(attackerSid).trim() === String(ownerSid).trim()) {
      if (!isCharge || isDetonator) {
        return;
      }
    }

    // Charges/C4 are ignored when destroyed by a Detonator (raid explosion encounter)
    if (isCharge && isDetonator) {
      return;
    }

    const pick = (...lists) => lists.find((l) => Array.isArray(l) && l.length > 0);
    const eligibleSids = [...(pick(alert.eligibleSteamIds, alert.groupMemberSteamIds, alert.onlineMemberSteamIds) || (ownerSid ? [ownerSid] : []))];

    if (eligibleSids.length === 0) return;

    const isFinished = Boolean(alert.isFinished);
    const burstKey = `${eligibleSids.sort().join(",")}:${alert.objectName || ""}:${alert.location || ""}:${isFinished}`;
    const now = Date.now();
    const lastTime = this.recentAlerts.get(burstKey) || 0;

    if (now - lastTime < 5000) {
      // Coalesce / suppress identical alerts within 5s
      return;
    }
    this.recentAlerts.set(burstKey, now);

    // Prune cache if large
    if (this.recentAlerts.size > 1000) {
      for (const [k, t] of this.recentAlerts.entries()) {
        if (now - t > 60000) this.recentAlerts.delete(k);
      }
    }

    // Resolve Discord IDs for all eligible members
    const targets = new Map(); // discordId -> { steamId, dmAlerts }
    for (const sid of eligibleSids) {
      const link = this.linkRepo.getLinkBySteam(sid);
      if (link && link.discord_id) {
        targets.set(link.discord_id, {
          steamId: link.steam_id,
          dmAlerts: Boolean(link.raid_alerts_dm),
        });
      }
    }

    if (targets.size === 0) return;

    const embed = this.buildRaidEmbed(alert, isFinished);
    const targetDiscordIds = Array.from(targets.keys());

    // 1. Direct Messages
    for (const [did, info] of targets.entries()) {
      if (info.dmAlerts) {
        try {
          const user = await this.client.users.fetch(did).catch(() => null);
          if (user) {
            await user.send({ embeds: [embed] }).catch(() => {});
          }
        } catch {}
      }
    }

    // 2. Guild Raid Channels
    const mentions = targetDiscordIds.map((id) => `<@${id}>`).join(" ");
    const guildConfigs = this.guildRepo.getAllGuildConfigs();

    for (const cfg of guildConfigs) {
      if (!cfg.raidChannelId) continue;
      try {
        const guild = this.client.guilds.cache.get(cfg.guildId) || (await this.client.guilds.fetch(cfg.guildId).catch(() => null));
        if (!guild) continue;

        const channel = guild.channels.cache.get(cfg.raidChannelId) || (await guild.channels.fetch(cfg.raidChannelId).catch(() => null));
        if (channel && channel.isTextBased()) {
          await channel.send({
            content: mentions,
            embeds: [embed],
            allowedMentions: { users: targetDiscordIds.map(String).filter((id) => /^\d{5,25}$/.test(id)).slice(0, 100) },
          });
        }
      } catch (err) {
        console.warn(`[raidNotifier] Failed to send channel raid alert: ${err.message}`);
      }
    }
  }
}

module.exports = { RaidNotifier };
