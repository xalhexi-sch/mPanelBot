const crypto = require("node:crypto");
const { WebhookClient, PermissionFlagsBits } = require("discord.js");
const { createCommand } = require("../../websocket/protocol");
const { WebhookDeliveryQueue } = require("./webhookDeliveryQueue");
const { redactWebhookUrl } = require("../../utils/security");

const DEFAULT_AVATAR_URL = "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";

class ChatRelay {
  constructor({ discordClient, wsServer, guildRepo, webhookQueue = null, avatars = null }) {
    this.avatars = avatars;
    this.client = discordClient;
    this.wsServer = wsServer;
    this.guildRepo = guildRepo;

    // Cache of guildId -> WebhookClient
    this.webhookClients = new Map();

    // Loop prevention: in-memory LRU tracking of recent message IDs
    this.recentMessageIds = new Set();
    this.recentMessageOrder = [];

    // Bounded delivery queue for outbound game -> discord messages
    this.queue =
      webhookQueue ||
      new WebhookDeliveryQueue({
        maxCapacity: 100,
        onWebhookInvalid: ({ guildId }) => this.handleWebhookInvalid(guildId),
      });
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
   * Handles webhook invalidation (e.g. 404 Unknown Webhook if deleted in Discord).
   * Cleans up client and resets stored URL so next send will re-discover or re-create it.
   */
  handleWebhookInvalid(guildId) {
    const existing = this.webhookClients.get(guildId);
    if (existing && typeof existing.destroy === "function") {
      try {
        existing.destroy();
      } catch {}
    }
    this.webhookClients.delete(guildId);

    try {
      this.guildRepo.upsertGuildConfig(guildId, { chatWebhookUrl: null });
      console.log(`[chatRelay] Reset invalid webhook URL for guild ${guildId}`);
    } catch (err) {
      console.warn(`[chatRelay] Error resetting webhook config for guild ${guildId}: ${err.message}`);
    }
  }

  /**
   * Retrieves an existing WebhookClient or resolves/creates one for the channel.
   */
  async getOrCreateWebhookClient(cfg, guild) {
    if (!cfg || !cfg.guildId) return null;
    const guildId = cfg.guildId;

    // 1. Check in-memory cache
    if (this.webhookClients.has(guildId)) {
      return this.webhookClients.get(guildId);
    }

    // 2. Check stored webhook URL
    if (cfg.chatWebhookUrl) {
      try {
        const client = new WebhookClient({ url: cfg.chatWebhookUrl });
        this.webhookClients.set(guildId, client);
        return client;
      } catch (err) {
        console.warn(`[chatRelay] Failed to instantiate WebhookClient from stored URL: ${redactWebhookUrl(err.message)}`);
      }
    }

    // 3. Auto-discover or auto-create if chat channel is set
    if (!guild || !cfg.chatChannelId) return null;

    try {
      const channel =
        guild.channels.cache.get(cfg.chatChannelId) ||
        (await guild.channels.fetch(cfg.chatChannelId).catch(() => null));

      if (!channel || typeof channel.fetchWebhooks !== "function") return null;

      // Check permissions
      const me = guild.members?.me || guild.members?.cache?.get(this.client.user?.id);
      const perms = channel.permissionsFor ? channel.permissionsFor(me) : null;
      if (perms && !perms.has(PermissionFlagsBits.ManageWebhooks)) {
        return null;
      }

      // Check existing webhooks in channel to prevent duplicates
      const webhooks = await channel.fetchWebhooks();
      const botUserId = this.client.user?.id;
      let webhook = webhooks.find(
        (w) => w.name === "mPanel Chat Relay" || (botUserId && w.owner?.id === botUserId)
      );

      if (!webhook && typeof channel.createWebhook === "function") {
        const avatarUrl = this.client.user?.displayAvatarURL ? this.client.user.displayAvatarURL() : null;
        webhook = await channel.createWebhook({
          name: "mPanel Chat Relay",
          avatar: avatarUrl,
          reason: "mPanel in-game chat relay webhook",
        });
      }

      if (webhook && webhook.url) {
        this.guildRepo.upsertGuildConfig(guildId, { chatWebhookUrl: webhook.url });
        const client = new WebhookClient({ url: webhook.url });
        this.webhookClients.set(guildId, client);
        return client;
      }
    } catch (err) {
      console.warn(`[chatRelay] Auto-discovery of webhook failed for guild ${guildId}: ${redactWebhookUrl(err.message)}`);
    }

    return null;
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

    let delivered = false;
    for (const session of sessions) {
      try {
        commandEnvelope.serverId = session.serverId;
        const res = await session.sendCommand(commandEnvelope, 8000);
        if (res?.payload?.delivered !== false && res?.payload?.success !== false) {
          delivered = true;
        }
      } catch (err) {
        console.warn(`[chatRelay] Relay to ${session.serverId} failed: ${err.message}`);
      }
    }

    if (delivered) {
      try {
        await message.react("✅").catch(() => {});
      } catch {}
    }
  }

  /**
   * Unturned -> Discord
   * Receives game chat events, disarms pings, applies player name & avatar formatting,
   * and delivers to Discord via Webhook through the bounded delivery queue.
   * NOTE: Chat message content is NEVER saved to SQLite/MySQL.
   */
  async handleGameChatEvent({ serverId, serverName, steamId, playerName, message, mode = "Global", avatarUrl }) {
    const cleanMsg = String(message || "").trim();
    if (!cleanMsg) return;

    // Format username: max 32 characters, strip invalid characters (@, #, :, `)
    const sName = serverName || serverId;
    const cleanPlayerName = String(playerName || "Player").trim().replace(/[@#:`]/g, "");
    const formattedUsername = sName
      ? `[${sName}] ${cleanPlayerName}`.slice(0, 32)
      : cleanPlayerName.slice(0, 32);

    // Real Steam avatar (cached, never blocks on failure), then the default
    const steamAvatar = !avatarUrl && this.avatars ? await this.avatars.get(steamId) : null;
    const resolvedAvatar =
      avatarUrl && typeof avatarUrl === "string" && avatarUrl.startsWith("http")
        ? avatarUrl
        : steamAvatar || DEFAULT_AVATAR_URL;

    const configs = this.guildRepo.getAllGuildConfigs();

    for (const cfg of configs) {
      if (!cfg.chatChannelId) continue;

      try {
        const guild =
          this.client.guilds.cache.get(cfg.guildId) ||
          (await this.client.guilds.fetch(cfg.guildId).catch(() => null));

        const webhookClient = await this.getOrCreateWebhookClient(cfg, guild);

        if (webhookClient) {
          // Enqueue to bounded queue (handles rate limiting and queue overflow safely)
          this.queue.enqueue({
            webhookClient,
            guildId: cfg.guildId,
            payload: {
              content: cleanMsg.slice(0, 2000),
              username: formattedUsername,
              avatarURL: resolvedAvatar,
              allowedMentions: { parse: [] }, // Disarm @everyone, @here, and role pings
            },
          });
        } else if (guild) {
          // Fallback to bot message if webhook is not accessible
          const channel =
            guild.channels.cache.get(cfg.chatChannelId) ||
            (await guild.channels.fetch(cfg.chatChannelId).catch(() => null));

          if (channel && channel.isTextBased()) {
            const formattedFallback = `💬 **[${mode}] [${cleanPlayerName}](https://steamcommunity.com/profiles/${steamId || "0"}):** ${cleanMsg.slice(0, 1000)}`;
            await channel.send({
              content: formattedFallback,
              allowedMentions: { parse: [] },
            });
          }
        }
      } catch (err) {
        console.warn(`[chatRelay] Failed to deliver game chat: ${redactWebhookUrl(err.message)}`);
      }
    }
  }
}

module.exports = { ChatRelay, DEFAULT_AVATAR_URL };
