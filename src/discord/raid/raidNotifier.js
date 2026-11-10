const { EmbedBuilder } = require("discord.js");

class RaidNotifier {
  constructor({ discordClient, linkRepo, guildRepo }) {
    this.client = discordClient;
    this.linkRepo = linkRepo;
    this.guildRepo = guildRepo;
    this.recentAlerts = new Map(); // key -> timestamp
  }

  buildRaidEmbed(alert, isFinished = false) {
    const objectName = (alert.objectName || "structure").trim();
    const location = (alert.location || "Unknown").trim();
    const attacker = (alert.attackerName || "").trim();
    const attackerSid = (alert.attackerSteamId || "").trim();
    const weapon = (alert.weapon || alert.weaponName || "").trim();

    if (isFinished) {
      return new EmbedBuilder()
        .setColor(0x57f287) // Green
        .setTitle("✅ Finished Raid Alert!")
        .setDescription(`No more damage detected on buildables near **${location}** in the last **10 minutes**.`)
        .setTimestamp();
    }

    const embed = new EmbedBuilder()
      .setColor(0xed4245) // Red
      .setTitle("🚨 Raid Alert!")
      .setDescription(`Your **${objectName}** near **${location}** is under attack or has been destroyed!`)
      .setTimestamp();

    if (attacker) {
      const attackerVal = attackerSid
        ? `[${attacker}](https://steamcommunity.com/profiles/${attackerSid})`
        : attacker;
      embed.addFields({ name: "Attacker", value: attackerVal, inline: true });
    }

    if (weapon) {
      embed.addFields({ name: "Weapon", value: weapon, inline: true });
    }

    embed.setFooter({ text: "Raid Alerts" });
    return embed;
  }

  async handleRaidAlert(alert) {
    const ownerSid = alert.ownerSteamId || alert.steamId;
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
