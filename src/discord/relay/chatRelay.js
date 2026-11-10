const { EmbedBuilder } = require("discord.js");
const crypto = require("node:crypto");
const { createCommand } = require("../../websocket/protocol");

class ChatRelay {
  constructor({ discordClient, wsServer, guildRepo, avatars = null }) {
    this.avatars = avatars;
    this.client = discordClient;
    this.wsServer = wsServer;
    this.guildRepo = guildRepo;

    // Loop prevention: in-memory LRU tracking of recent message IDs
    this.recentMessageIds = new Set();
    this.recentMessageOrder = [];

    // Per-Discord-user flood guard: one relayed line per `userCooldownMs`.
    this.userCooldownMs = 1500;
    this.lastRelayAt = new Map();
  }

  /** @returns {boolean} true when this user may relay now. Map is pruned so it stays small. */
  allowUser(userId, now = Date.now()) {
    const last = this.lastRelayAt.get(userId) || 0;
    if (now - last < this.userCooldownMs) return false;
    this.lastRelayAt.set(userId, now);
    if (this.lastRelayAt.size > 1000) {
      for (const [id, t] of this.lastRelayAt) if (now - t > this.userCooldownMs) this.lastRelayAt.delete(id);
    }
    return true;
  }

  isChatChannel(channelId) {
    if (!channelId) return false;
    const configs = this.guildRepo.getAllGuildConfigs();
    return configs.some((c) => c.chatChannelId === channelId);
  }

  /**
   * Tracks recently processed Discord message IDs with a bounded capacity (max 500)
   * to guarantee zero duplicate processing or loop bounce.
   */
  markRecentMessage(messageId) {
    if (!messageId) return;
    this.recentMessageIds.add(messageId);
    this.recentMessageOrder.push(messageId);
    if (this.recentMessageOrder.length > 500) {
      const oldest = this.recentMessageOrder.shift();
      if (oldest) this.recentMessageIds.delete(oldest);
    }
  }

  isRecentMessage(messageId) {
    return Boolean(messageId && this.recentMessageIds.has(messageId));
  }

  /**
   * Discord -> Unturned
   * Receives incoming Discord messages, validates eligibility, guards against loops,
   * formats author identity, and broadcasts to connected Unturned servers over WebSocket.
   */
  async handleDiscordMessage(message) {
    if (!message) return;

    // Strict Loop Guard 1: Webhook messages must NEVER be relayed back into game
    if (message.webhookId) return;

    // Strict Loop Guard 2: Bot messages must NEVER be relayed
    if (message.author?.bot) return;

    // Strict Loop Guard 3: System messages
    if (message.system) return;

    // Channel membership check
    if (!this.isChatChannel(message.channelId)) return;

    // Loop Guard 4: In-memory recent message deduplication
    if (this.isRecentMessage(message.id)) return;
    this.markRecentMessage(message.id);

    // Command/prefix ignore check
    const content = String(message.cleanContent || message.content || "").trim();
    if (!content || content.startsWith("/") || content.startsWith("!")) {
      return;
    }

    const sessions = this.wsServer.getActiveSessions();
    if (sessions.length === 0) return;
    if (!this.allowUser(message.author?.id || "unknown")) return;

    const authorName = message.member?.displayName || message.author.displayName || message.author.username || "Discord";
    const avatarUrl = message.author.displayAvatarURL ? message.author.displayAvatarURL({ size: 64, extension: "png" }) : null;
    const color =
      message.member?.displayHexColor && message.member.displayHexColor !== "#000000"
        ? message.member.displayHexColor
        : null;

    const correlationId = crypto.randomUUID();
    const relayId = `${message.channelId}:${message.id}`;

    // Payload perfectly aligned with C# ChatRelayRequestPayload
    const commandEnvelope = createCommand({
      type: "chat.relay.request",
      serverId: "all",
      correlationId,
      payload: {
        relayId,
        discordMessageId: message.id,
        channelId: message.channelId,
        username: authorName,
        authorName,
        discordUserName: authorName,
        discordUserId: message.author.id,
        message: content.slice(0, 200),
        avatarUrl,
        color,
      },
      timeoutMs: 8000,
    });

    // Fan out in parallel: one hung server must not delay delivery to the others by its full timeout.
    const results = await Promise.allSettled(
      sessions.map((session) =>
        session.sendCommand({ ...commandEnvelope, serverId: session.serverId }, 8000).catch((err) => {
          console.warn(`[chatRelay] Relay to ${session.serverId} failed: ${err.message}`);
          throw err;
        })
      )
    );
    const delivered = results.some(
      (r) => r.status === "fulfilled" && r.value?.payload?.delivered !== false && r.value?.payload?.success !== false
    );

    if (delivered) {
      try {
        await message.react("✅").catch(() => {});
      } catch {}
    }
  }

  /**
   * Unturned -> Discord
   * Receives game chat events, disarms pings, applies player name & avatar formatting,
   * and posts it to the configured chat channel as an embed.
   * NOTE: Chat message content is NEVER saved to SQLite/MySQL.
   */
  async handleGameChatEvent({ serverId, steamId, playerName, message, mode = "Global", locationName = null, group = null }) {
    const cleanMsg = String(message || "").trim();
    if (!cleanMsg) return;

    const name = String(playerName || "Player").trim().replace(/[@#`]/g, "") || "Player";
    const profile = this.avatars && steamId ? await this.avatars.getProfile(steamId) : { avatarUrl: null };

    // Old Blood Horizon chat card: [avatar] **Name: message** (+ footer for local/group chat)
    const author = { name: `${name}: ${cleanMsg}`.slice(0, 256) };
    if (profile.avatarUrl) author.iconURL = profile.avatarUrl;
    if (steamId) author.url = `https://steamcommunity.com/profiles/${steamId}`;
    const embed = new EmbedBuilder().setColor(0xd41111).setAuthor(author).setTimestamp();

    const m = String(mode || "").toLowerCase();
    if (m === "local" || m === "area") embed.setFooter({ text: `Local: ${locationName || "Unknown"}` });
    else if (m === "group") embed.setFooter({ text: `Group: ${group?.name || group?.id || "Unknown"}` });

    for (const cfg of this.guildRepo.getAllGuildConfigs()) {
      if (!cfg.chatChannelId) continue;
      try {
        const channel = await this.client.channels.fetch(cfg.chatChannelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
        }
      } catch (err) {
        console.warn(`[chatRelay] Failed to deliver game chat: ${err.message}`);
      }
    }
  }
}

module.exports = { ChatRelay };
