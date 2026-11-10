const crypto = require("node:crypto");
const { createCommand } = require("../../websocket/protocol");

class ChatRelay {
  constructor({ discordClient, wsServer, guildRepo }) {
    this.client = discordClient;
    this.wsServer = wsServer;
    this.guildRepo = guildRepo;
  }

  isChatChannel(channelId) {
    if (!channelId) return false;
    const configs = this.guildRepo.getAllGuildConfigs();
    return configs.some((c) => c.chatChannelId === channelId);
  }

  async handleDiscordMessage(message) {
    if (!message || message.author?.bot) return;
    if (!this.isChatChannel(message.channelId)) return;

    const content = String(message.cleanContent || message.content || "").trim();
    if (!content || content.startsWith("/") || content.startsWith("!")) {
      return;
    }

    const sessions = this.wsServer.getActiveSessions();
    if (sessions.length === 0) return;

    const correlationId = crypto.randomUUID();
    const commandEnvelope = createCommand({
      type: "chat.relay.request",
      serverId: "all",
      correlationId,
      payload: {
        discordUserId: message.author.id,
        discordUserName: message.author.displayName || message.author.username,
        message: content.slice(0, 200),
        channelId: message.channelId,
      },
      timeoutMs: 8000,
    });

    let delivered = false;
    for (const session of sessions) {
      try {
        commandEnvelope.serverId = session.serverId;
        const res = await session.sendCommand(commandEnvelope, 8000);
        if (res?.payload?.success !== false) {
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

  async handleGameChatEvent({ serverId, steamId, playerName, message, mode = "Global" }) {
    const cleanMsg = String(message || "").trim();
    if (!cleanMsg) return;

    const configs = this.guildRepo.getAllGuildConfigs();
    const formatted = `💬 **[${mode}] [${playerName || "Player"}](https://steamcommunity.com/profiles/${steamId}):** ${cleanMsg.slice(0, 1000)}`;

    for (const cfg of configs) {
      if (!cfg.chatChannelId) continue;
      try {
        const guild = this.client.guilds.cache.get(cfg.guildId) || (await this.client.guilds.fetch(cfg.guildId).catch(() => null));
        if (!guild) continue;

        const channel = guild.channels.cache.get(cfg.chatChannelId) || (await guild.channels.fetch(cfg.chatChannelId).catch(() => null));
        if (channel && channel.isTextBased()) {
          await channel.send({ content: formatted });
        }
      } catch (err) {
        console.warn(`[chatRelay] Failed to forward game chat: ${err.message}`);
      }
    }
  }
}

module.exports = { ChatRelay };
