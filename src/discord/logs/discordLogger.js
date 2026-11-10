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
  constructor({ discordClient, guildRepo, avatars = null, snapshotRepo = null, linkRepo = null, groupWaitMs = 6000 } = {}) {
    this.groupWaitMs = groupWaitMs;
    this.linkRepo = linkRepo;
    this.client = discordClient;
    this.guildRepo = guildRepo;
    this.avatars = avatars;
    this.snapshotRepo = snapshotRepo;
    this.groupBySteam = new Map();
  }

  /** Remember each online player's group id from the newest status snapshot (game's server.json knows it even when the join event does not). */
  rememberGroups(players) {
    for (const p of Array.isArray(players) ? players : []) {
      if (p?.steamId && p.groupId) this.groupBySteam.set(String(p.steamId), String(p.groupId));
    }
    if (this.groupBySteam.size > 5000) this.groupBySteam.delete(this.groupBySteam.keys().next().value);
  }

  async _groupIdFor(steamId, waitMs = 0) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const id = this.groupBySteam.get(String(steamId));
      if (id || Date.now() >= deadline) return id || null;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Human server name (from the live snapshot) falling back to the server id. */
  _serverLabel(serverId) {
    try {
      const snap = this.snapshotRepo?.getSnapshot(serverId);
      if (snap?.serverName) return snap.serverName;
    } catch {}
    return serverId || "Unknown";
  }

  /** Compact log card: [steam avatar] **Name: text** with `Server • time` footer (matches the old Blood Horizon logs). */
  async _playerLine({ color, steamId, playerName, text, serverId }) {
    const name = String(playerName || "Unknown").slice(0, 64);
    const icon = this.avatars && steamId ? await this.avatars.get(steamId).catch(() => null) : null;
    const author = { name: `${name}${text ? `: ${text}` : ""}`.slice(0, 256) };
    if (icon) author.iconURL = icon;
    if (steamId) author.url = `https://steamcommunity.com/profiles/${steamId}`;
    return new EmbedBuilder()
      .setColor(color)
      .setAuthor(author)
      .setFooter({ text: this._serverLabel(serverId) })
      .setTimestamp();
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

  /** Old Blood Horizon "Player Joined / Player Left" card: avatar thumbnail, Discord link, Steam group, account age. */
  async _joinLeaveEmbed(kind, data) {
    const { serverId, steamId, playerName, group } = data;
    const profile = this.avatars && steamId ? await this.avatars.getProfile(steamId) : { avatarUrl: null, createdUnix: null };

    // Group: plugin sends {kind,id,name,url}; resolve a nicer Steam group name when we only have the gid
    let groupText = "None";
    let g0 = group && (group.name || group.id) ? group : null;
    if (!g0 && steamId) {
      // The join event has no group; the status snapshot may need a few seconds to include a brand-new player
      const gid = await this._groupIdFor(steamId, kind === "join" ? this.groupWaitMs : 0);
      if (gid && gid !== "0") g0 = { kind: "steam", id: gid };
    }
    if (g0) {
      const group2 = g0;
      let name = group2.name;
      let url = group2.url;
      if (this.avatars && group2.id && (!name || name === group2.id)) {
        const g = await this.avatars.getGroup(group2.id).catch(() => null);
        if (g) ({ name, url } = g);
      }
      const label = String(name || group2.id).replace(/[\[\]()*_`~|>]/g, "").slice(0, 64);
      groupText = url ? `[${label}](${url})` : label;
    }

    let discordText = "Unlinked";
    try {
      const link = steamId && this.linkRepo ? this.linkRepo.getLinkBySteam(String(steamId)) : null;
      if (link?.discord_id) discordText = `<@${link.discord_id}>`;
    } catch {}

    const joined = kind === "join";
    const duration = data.durationSeconds ?? data.sessionLengthSeconds;
    const embed = new EmbedBuilder()
      .setTitle(joined ? "Player Joined" : "Player Left")
      .setColor(joined ? 0x57f287 : 0xed4245)
      .setFooter({ text: this._serverLabel(serverId) })
      .setTimestamp()
      .addFields(
        { name: "Player", value: formatPlayer(playerName, steamId), inline: true },
        { name: "Steam ID", value: steamId ? `\`${steamId}\`` : "Unknown", inline: true },
        { name: "Discord", value: discordText, inline: true },
        { name: "Group", value: groupText, inline: true },
        joined
          ? { name: "Created", value: profile.createdUnix ? `<t:${profile.createdUnix}:R>` : "Unknown / private profile", inline: true }
          : { name: "Session Time", value: duration != null ? formatDuration(duration) : "Unknown", inline: true }
      );
    if (profile.avatarUrl) embed.setThumbnail(profile.avatarUrl);
    return embed;
  }

  async logPlayerConnected(data = {}) {
    try {
      await this._broadcastToChannel("joinLeaveChannelId", await this._joinLeaveEmbed("join", data || {}));
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPlayerConnected: ${err.message}`);
    }
  }

  async logPlayerDisconnected(data = {}) {
    try {
      await this._broadcastToChannel("joinLeaveChannelId", await this._joinLeaveEmbed("leave", data || {}));
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPlayerDisconnected: ${err.message}`);
    }
  }

  async logCommand(data = {}) {
    try {
      const { serverId, steamId, playerName, command, commandText } = data || {};
      const rawCmd = command !== undefined ? command : commandText;
      const safeCommand = sanitizeLoggedCommand(rawCmd || "").replace(/`/g, "'") || "(empty)";
      const embed = await this._playerLine({ color: 0xd41111, steamId, playerName, text: safeCommand, serverId });
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
        .setFooter({ text: "Logs" });

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
