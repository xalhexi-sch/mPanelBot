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

/** Steam (clan) ids: universe 1, account type 7. In-game groups use a different id type. */
function looksLikeSteamGroupId(id) {
  try {
    const v = BigInt(String(id));
    return v >> 56n === 1n && ((v >> 52n) & 0xfn) === 7n;
  } catch {
    return false;
  }
}

const cleanLabel = (name) => String(name || "").replace(/[\[\]()*_`~|>]/g, "").trim().slice(0, 64);

class DiscordLogger {
  constructor({ discordClient, guildRepo, avatars = null, snapshotRepo = null, linkRepo = null, groupWaitMs = 6000, groupRetryDelaysMs = [20_000, 90_000, 300_000] } = {}) {
    this.groupRetryDelaysMs = groupRetryDelaysMs;
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
    const sent = [];
    if (!this.guildRepo || typeof this.guildRepo.getAllGuildConfigs !== "function") {
      return sent;
    }
    if (!this.client) {
      return sent;
    }

    let configs = [];
    try {
      configs = this.guildRepo.getAllGuildConfigs() || [];
    } catch (err) {
      console.warn(`[discordLogger] Failed to query guild configs: ${err.message}`);
      return sent;
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
          const message = await channel.send({ embeds: [embed] }).catch((err) => {
            console.warn(`[discordLogger] Failed to send embed to channel ${channelId} in guild ${cfg.guildId}: ${err.message}`);
            return null;
          });
          if (message) sent.push(message);
        }
      } catch (err) {
        console.warn(`[discordLogger] Error delivering log to channel ${channelId}: ${err.message}`);
      }
    }
    return sent;
  }

  /**
   * Group field: a Steam group is a clickable link to its Steam page; an in-game group (or anything we cannot
   * identify as a Steam group) is just its name, and "None" when there is nothing to show.
   */
  async _formatGroup(group) {
    return (await this._formatGroupDetailed(group)).text;
  }

  /** @returns {{text:string, pending:boolean}} pending = a Steam group whose name could not be fetched yet */
  async _formatGroupDetailed(group) {
    const isSteam = String(group.kind || "").toLowerCase() !== "ingame";
    let name = cleanLabel(group.name);
    if (!isSteam) return { text: name || "None", pending: false };

    let url = group.url || null;
    if (this.avatars && group.id && (!name || name === String(group.id))) {
      const found = await this.avatars.getGroup(group.id).catch(() => null);
      if (found) {
        name = cleanLabel(found.name);
        url = found.url;
      }
    }
    if (!url && group.id && looksLikeSteamGroupId(group.id)) url = `https://steamcommunity.com/gid/${group.id}`;

    if (name && name !== String(group.id)) return { text: url ? `[${name}](${url})` : name, pending: false };
    // Name unknown for now (Steam rate-limited/unreachable). Show a placeholder; it is replaced by the real name shortly.
    return url ? { text: `[Fetching name…](${url})`, pending: true } : { text: "None", pending: false };
  }

  /** Old Blood Horizon "Player Joined / Player Left" card: avatar thumbnail, Discord link, Steam group, account age. */
  async _joinLeaveEmbed(kind, data, isRetry = false) {
    const { serverId, steamId, playerName, group } = data;
    const profile = this.avatars && steamId ? await this.avatars.getProfile(steamId) : { avatarUrl: null, createdUnix: null };

    // Group: plugin sends {kind,id,name,url}; resolve a nicer Steam group name when we only have the gid
    let groupText = "None";
    let pending = false;
    let g0 = group && (group.name || group.id) ? group : null;
    if (!g0 && steamId) {
      // The join event has no group; the status snapshot may need a few seconds to include a brand-new player
      const gid = await this._groupIdFor(steamId, kind === "join" && !isRetry ? this.groupWaitMs : 0);
      if (gid && gid !== "0") g0 = { kind: "steam", id: gid };
    }
    if (g0) ({ text: groupText, pending } = await this._formatGroupDetailed(g0));

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
    return { embed, pending };
  }

  /** Send a join/leave card; if the group name is still unknown, edit the message once Steam answers. */
  async _sendJoinLeave(kind, data) {
    const { embed, pending } = await this._joinLeaveEmbed(kind, data);
    const messages = await this._broadcastToChannel("joinLeaveChannelId", embed);
    if (pending && messages.length) this._scheduleGroupRetry(kind, data, messages, 0);
  }

  _scheduleGroupRetry(kind, data, messages, attempt) {
    const delay = this.groupRetryDelaysMs[attempt];
    if (delay === undefined) return;
    const timer = setTimeout(async () => {
      try {
        const { embed, pending } = await this._joinLeaveEmbed(kind, { ...data, group: data.group }, true);
        if (!pending) {
          await Promise.all(messages.map((m) => m.edit({ embeds: [embed] }).catch(() => {})));
        } else {
          this._scheduleGroupRetry(kind, data, messages, attempt + 1);
        }
      } catch {}
    }, delay);
    timer.unref?.();
  }

  async logPlayerConnected(data = {}) {
    try {
      await this._sendJoinLeave("join", data || {});
    } catch (err) {
      console.warn(`[discordLogger] Unexpected error in logPlayerConnected: ${err.message}`);
    }
  }

  async logPlayerDisconnected(data = {}) {
    try {
      await this._sendJoinLeave("leave", data || {});
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
