const { EmbedBuilder } = require("discord.js");

const SENSITIVE_CMD_PATTERN = /\b(login|logon|register|password|apikey|token|auth|link)\b\s+([^\s]+)/gi;
const HIGH_ENTROPY_TOKEN = /\b[a-zA-Z0-9_\-]{24,}\b/g;

function sanitizeLoggedCommand(cmdText) {
  if (!cmdText) return "";
  let clean = String(cmdText).slice(0, 1000);
  clean = clean.replace(SENSITIVE_CMD_PATTERN, "$1 [REDACTED]");
  clean = clean.replace(HIGH_ENTROPY_TOKEN, "[REDACTED_SECRET]");
  return clean;
}

function sanitizeText(text, maxLength = 1000) {
  if (!text) return "";
  let clean = String(text).slice(0, maxLength);
  clean = clean.replace(HIGH_ENTROPY_TOKEN, "[REDACTED_SECRET]");
  return clean;
}

function formatDuration(seconds) {
  const sec = Number(seconds);
  if (isNaN(sec) || sec < 0) {
    return String(seconds || "0s");
  }
  const totalSeconds = Math.floor(sec);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatPlayer(name, steamId) {
  const safeName = String(name || "Unknown").slice(0, 64);
  if (steamId) {
    return `[${safeName}](https://steamcommunity.com/profiles/${steamId})`;
  }
  return safeName;
}

class DiscordLogger {
  constructor({ discordClient, guildRepo } = {}) {
    this.client = discordClient;
    this.guildRepo = guildRepo;
  }

  async _broadcastToChannel(channelKey, embed) {
    if (!this.guildRepo || typeof this.guildRepo.getAllGuildConfigs !== "function") {
      return;
    }
    if (!this.client) {
      return;
    }

    let configs = [];
    try {
      configs = this.guildRepo.getAllGuildConfigs() || [];
    } catch (err) {
      console.warn(`[discordLogger] Failed to query guild configs: ${err.message}`);
      return;
    }

    for (const cfg of configs) {
      const channelId = cfg[channelKey];
      if (!channelId) continue;

      try {
        let guild = null;
        if (this.client.guilds?.cache) {
          guild = this.client.guilds.cache.get(cfg.guildId);
        }
        if (!guild && typeof this.client.guilds?.fetch === "function") {
          guild = await this.client.guilds.fetch(cfg.guildId).catch(() => null);
        }
        if (!guild) continue;

        let channel = null;
        if (guild.channels?.cache) {
          channel = guild.channels.cache.get(channelId);
        }
        if (!channel && typeof guild.channels?.fetch === "function") {
          channel = await guild.channels.fetch(channelId).catch(() => null);
        }
        if (!channel && typeof this.client.channels?.fetch === "function") {
          channel = await this.client.channels.fetch(channelId).catch(() => null);
        }
        if (!channel) continue;

        if (typeof channel.isTextBased === "function" && !channel.isTextBased()) {
          continue;
        }

        if (typeof channel.send === "function") {
          await channel.send({ embeds: [embed] }).catch((err) => {
            console.warn(`[discordLogger] Failed to send embed to channel ${channelId} in guild ${cfg.guildId}: ${err.message}`);
          });
        }
      } catch (err) {
        console.warn(`[discordLogger] Error delivering log to channel ${channelId}: ${err.message}`);
      }
    }
  }

  async logPlayerConnected(data = {}) {
    try {
      const { serverId, steamId, playerName, ping } = data || {};
      const embed = new EmbedBuilder()
        .setColor(0x57f287) // Green
        .setTitle("🟢 Player Connected")
        .addFields(
          { name: "Player", value: formatPlayer(playerName, steamId), inline: true },
          { name: "Steam64 ID", value: steamId ? `\`${steamId}\`` : "Unknown", inline: true },
          { name: "Server", value: `\`${serverId || "Unknown"}\``, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "mPanel Logging" });

      if (ping != null && !isNaN(Number(ping))) {
        embed.addFields({ name: "Ping", value: `${ping}ms`, inline: true });
      }

      await this._broadcastToChannel("joinLeaveChannelId", embed);
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPlayerConnected: ${err.message}`);
    }
  }

  async logPlayerDisconnected(data = {}) {
    try {
      const { serverId, steamId, playerName, durationSeconds, sessionLengthSeconds } = data || {};
      const duration = durationSeconds !== undefined ? durationSeconds : sessionLengthSeconds;

      const embed = new EmbedBuilder()
        .setColor(0xed4245) // Red
        .setTitle("🔴 Player Disconnected")
        .addFields(
          { name: "Player", value: formatPlayer(playerName, steamId), inline: true },
          { name: "Steam64 ID", value: steamId ? `\`${steamId}\`` : "Unknown", inline: true },
          { name: "Server", value: `\`${serverId || "Unknown"}\``, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "mPanel Logging" });

      if (duration != null) {
        embed.addFields({ name: "Session Duration", value: formatDuration(duration), inline: true });
      }

      await this._broadcastToChannel("joinLeaveChannelId", embed);
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPlayerDisconnected: ${err.message}`);
    }
  }

  async logCommand(data = {}) {
    try {
      const { serverId, steamId, playerName, command, commandText } = data || {};
      const rawCmd = command !== undefined ? command : commandText;
      const safeCommand = sanitizeLoggedCommand(rawCmd || "").replace(/`/g, "'") || "(empty)";

      const embed = new EmbedBuilder()
        .setColor(0x5865f2) // Blurple
        .setTitle("⌨️ Player Command")
        .addFields(
          { name: "Player", value: formatPlayer(playerName, steamId), inline: true },
          { name: "Steam64 ID", value: steamId ? `\`${steamId}\`` : "Unknown", inline: true },
          { name: "Server", value: `\`${serverId || "Unknown"}\``, inline: true },
          { name: "Command", value: `\`${safeCommand}\``, inline: false }
        )
        .setTimestamp()
        .setFooter({ text: "mPanel Logging" });

      await this._broadcastToChannel("commandLogChannelId", embed);
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logCommand: ${err.message}`);
    }
  }

  async logPunishment(data = {}) {
    try {
      const {
        serverId,
        adminSteamId,
        instigatorSteamId,
        adminName,
        instigatorName,
        action,
        targetSteamId,
        targetName,
        reason,
        duration,
        durationSeconds,
      } = data || {};

      const aSid = adminSteamId || instigatorSteamId;
      const aName = adminName || instigatorName || "Console";
      const act = String(action || "punish").toLowerCase();
      const safeReason = sanitizeText(reason || "No reason specified", 500);

      // Color coding based on punishment action
      let color = 0xed4245; // Default red (e.g. ban)
      if (act === "kick" || act === "warn") {
        color = 0xfee75c; // Yellow
      } else if (act === "mute") {
        color = 0xeb459e; // Fuchsia
      } else if (act === "unban" || act === "unmute") {
        color = 0x57f287; // Green
      }

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`🔨 Moderation: ${act.toUpperCase()}`)
        .addFields(
          { name: "Action", value: `\`${act}\``, inline: true },
          { name: "Target", value: formatPlayer(targetName, targetSteamId), inline: true },
          { name: "Target Steam64", value: targetSteamId ? `\`${targetSteamId}\`` : "Unknown", inline: true },
          { name: "Admin", value: formatPlayer(aName, aSid), inline: true },
          { name: "Server", value: `\`${serverId || "Unknown"}\``, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "mPanel Logging" });

      const dur = duration !== undefined ? duration : (durationSeconds ? formatDuration(durationSeconds) : null);
      if (dur) {
        embed.addFields({ name: "Duration", value: String(dur), inline: true });
      }

      embed.addFields({ name: "Reason", value: safeReason, inline: false });

      await this._broadcastToChannel("punishmentLogChannelId", embed);
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPunishment: ${err.message}`);
    }
  }
}

module.exports = {
  DiscordLogger,
  sanitizeLoggedCommand,
  formatDuration,
};
