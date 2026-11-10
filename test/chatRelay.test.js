const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { ChatRelay } = require("../src/discord/relay/chatRelay");
const { buildSetupCommand, handleSetupInteraction } = require("../src/discord/commands/setup");
const { PermissionFlagsBits } = require("discord.js");

describe("Chat relay (embeds, loop prevention, setup)", () => {
  let db;
  let guildRepo;
  let fakeWsServer;
  let activeSessions;
  let sentCommands;
  let fakeClient;
  let fakeWebhookClient;
  let deliveredWebhookMessages;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    guildRepo = new GuildRepository(db);

    sentCommands = [];
    activeSessions = [
      {
        serverId: "survival-1",
        serverName: "Survival Alpha",
        sendCommand: async (envelope, timeout) => {
          sentCommands.push({ envelope, timeout });
          return { payload: { delivered: true, success: true } };
        },
      },
    ];

    fakeWsServer = {
      getActiveSessions: () => activeSessions,
    };

    deliveredWebhookMessages = [];
    fakeWebhookClient = {
      send: async (payload) => {
        deliveredWebhookMessages.push(payload);
        return { id: "wh-msg-1" };
      },
      destroy: () => {},
    };

    fakeClient = {
      user: {
        id: "bot-user-123",
        tag: "mPanelBot#0001",
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/bot.png",
      },
      guilds: {
        cache: new Map(),
        fetch: async (id) => null,
      },
    };
  });

  describe("Unturned -> Discord delivery & zero persistence", () => {
    function relayWithChannel(avatars) {
      const sent = [];
      fakeClient.channels = { fetch: async () => ({ isTextBased: () => true, send: async (p) => (sent.push(p), { id: "m" }) }) };
      return { sent, relay: new ChatRelay({ discordClient: fakeClient, wsServer: fakeWsServer, guildRepo, avatars }) };
    }

    it("delivers game chat as an old-style card: [steam avatar] Name: message, mentions disarmed", async () => {
      guildRepo.upsertGuildConfig("guild-1", { chatChannelId: "channel-chat-1" });
      const { sent, relay } = relayWithChannel({ getProfile: async () => ({ avatarUrl: "https://cdn/avatar.jpg" }) });

      await relay.handleGameChatEvent({ serverId: "survival-1", steamId: "76561198000000001", playerName: "PlayerOne", message: "Hello survivors!", mode: "Global" });

      assert.strictEqual(sent.length, 1);
      const e = sent[0].embeds[0].toJSON();
      assert.strictEqual(e.author.name, "PlayerOne: Hello survivors!");
      assert.strictEqual(e.author.icon_url, "https://cdn/avatar.jpg");
      assert.strictEqual(e.color, 0xd41111);
      assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
      assert.ok(!e.footer, "global chat has no footer");
    });

    it("adds Local/Group footers and still delivers when the avatar lookup fails", async () => {
      guildRepo.upsertGuildConfig("guild-1", { chatChannelId: "channel-chat-1" });
      const { sent, relay } = relayWithChannel({ getProfile: async () => ({ avatarUrl: null }) });

      await relay.handleGameChatEvent({ serverId: "s", steamId: "1", playerName: "A", message: "hi", mode: "local", locationName: "Kuwait" });
      await relay.handleGameChatEvent({ serverId: "s", steamId: "1", playerName: "A", message: "hi", mode: "group", group: { name: "Team" } });

      assert.strictEqual(sent[0].embeds[0].toJSON().footer.text, "Local: Kuwait");
      assert.strictEqual(sent[1].embeds[0].toJSON().footer.text, "Group: Team");
      assert.ok(!sent[0].embeds[0].toJSON().author.icon_url);
    });

    it("should strictly never insert chat messages into SQLite database (zero persistence law)", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        chatChannelId: "channel-chat-1",
        chatWebhookUrl: "https://discord.com/api/webhooks/123/token",
      });

      const relay = new ChatRelay({
        discordClient: fakeClient,
        wsServer: fakeWsServer,
        guildRepo,
      });
      fakeClient.channels = { fetch: async () => ({ isTextBased: () => true, send: async () => ({}) }) };

      await relay.handleGameChatEvent({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "PlayerOne",
        message: "This secret in-game chat should not be stored in database",
      });

      await new Promise((r) => setImmediate(r));

      // Verify no tables exist containing chat messages
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      for (const t of tables) {
        assert.ok(!t.name.includes("chat_history") && !t.name.includes("chat_message"), "No chat history tables allowed");
      }
    });
  });

  describe("Discord -> Unturned Relay & Strict Loop Prevention", () => {
    it("should ignore messages originating from webhooks (message.webhookId)", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        chatChannelId: "channel-chat-1",
      });

      const relay = new ChatRelay({
        discordClient: fakeClient,
        wsServer: fakeWsServer,
        guildRepo,
      });

      const fakeWebhookMessage = {
        id: "msg-wh-1",
        webhookId: "123456789012345678", // Webhook identifier
        channelId: "channel-chat-1",
        content: "I am a webhook echoed message!",
        author: { bot: true, username: "[Server] PlayerOne" },
      };

      await relay.handleDiscordMessage(fakeWebhookMessage);
      assert.strictEqual(sentCommands.length, 0, "Webhook messages must never be relayed into the game (loop prevention)");
    });

    it("should ignore messages originating from bots (message.author.bot)", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        chatChannelId: "channel-chat-1",
      });

      const relay = new ChatRelay({
        discordClient: fakeClient,
        wsServer: fakeWsServer,
        guildRepo,
      });

      const fakeBotMessage = {
        id: "msg-bot-1",
        channelId: "channel-chat-1",
        content: "Bot notification",
        author: { bot: true, username: "SomeOtherBot" },
      };

      await relay.handleDiscordMessage(fakeBotMessage);
      assert.strictEqual(sentCommands.length, 0, "Bot messages must never be relayed into the game");
    });

    it("should ignore system messages and bot commands", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        chatChannelId: "channel-chat-1",
      });

      const relay = new ChatRelay({
        discordClient: fakeClient,
        wsServer: fakeWsServer,
        guildRepo,
      });

      // System message
      await relay.handleDiscordMessage({
        id: "msg-sys-1",
        channelId: "channel-chat-1",
        system: true,
        content: "User pinned a message",
        author: { bot: false },
      });

      // Slash/prefix command
      await relay.handleDiscordMessage({
        id: "msg-cmd-1",
        channelId: "channel-chat-1",
        content: "!help",
        author: { bot: false },
      });

      assert.strictEqual(sentCommands.length, 0, "System and command messages must be ignored");
    });

    it("should forward eligible member message with preserved username and avatar to game", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        chatChannelId: "channel-chat-1",
      });

      let reacted = false;
      const fakeUserMessage = {
        id: "msg-user-123",
        channelId: "channel-chat-1",
        content: "Watch out at the military base!",
        author: {
          id: "discord-user-88",
          username: "DiscordPlayer",
          displayName: "BobTheBuilder",
          bot: false,
          displayAvatarURL: () => "https://cdn.discordapp.com/avatars/user.png",
        },
        member: {
          displayName: "StaffBob",
          displayHexColor: "#5865F2",
        },
        react: async (emoji) => {
          if (emoji === "✅") reacted = true;
        },
      };

      const relay = new ChatRelay({
        discordClient: fakeClient,
        wsServer: fakeWsServer,
        guildRepo,
      });

      await relay.handleDiscordMessage(fakeUserMessage);

      assert.strictEqual(sentCommands.length, 1);
      const envelope = sentCommands[0].envelope;
      assert.strictEqual(envelope.type, "chat.relay.request");
      assert.strictEqual(envelope.payload.username, "StaffBob", "Must preserve member display name");
      assert.strictEqual(envelope.payload.authorName, "StaffBob");
      assert.strictEqual(envelope.payload.message, "Watch out at the military base!");
      assert.strictEqual(envelope.payload.color, "#5865F2");
      assert.strictEqual(envelope.payload.avatarUrl, "https://cdn.discordapp.com/avatars/user.png");
      assert.strictEqual(reacted, true, "Must acknowledge delivery with ✅ reaction");
    });
  });

  describe("/setup channels", () => {
    const channel = (id, allowed = true) => ({ id, permissionsFor: () => ({ has: () => allowed }) });
    const interactionFor = (guildId, channels, sink) => ({
      client: fakeClient,
      guild: { id: guildId, members: { me: {} } },
      options: { getSubcommand: () => "channels", getChannel: (name) => channels[name] || null },
      reply: async (obj) => { sink.content = obj.content; },
    });

    it("stores the chat channel without creating or needing any webhook", async () => {
      const out = {};
      await handleSetupInteraction(interactionFor("g1", { chat_channel: channel("chat-1") }, out), { guildRepo });
      assert.strictEqual(guildRepo.getGuildConfig("g1").chatChannelId, "chat-1");
      assert.ok(!/webhook/i.test(out.content), "no webhook wording or requirement");
    });

    it("refuses a channel where the bot cannot post embeds, and stores nothing", async () => {
      const out = {};
      await handleSetupInteraction(interactionFor("g2", { chat_channel: channel("locked", false) }, out), { guildRepo });
      assert.ok(out.content.includes("Embed Links"));
      assert.strictEqual(guildRepo.getGuildConfig("g2"), null);
    });

    it("the old webhook column and its stored URL are removed from existing databases", () => {
      const legacy = new DatabaseManager(":memory:");
      legacy.exec("ALTER TABLE guild_configs ADD COLUMN chat_webhook_url TEXT;");
      legacy.exec("INSERT INTO guild_configs (guild_id, chat_webhook_url, updated_at) VALUES ('old', 'https://discord.com/api/webhooks/1/secret', 'x')");
      legacy.dropLegacyWebhookColumn();
      const cols = legacy.prepare("PRAGMA table_info(guild_configs)").all().map((c) => c.name);
      assert.ok(!cols.includes("chat_webhook_url"), "credential column dropped");
      legacy.close();
    });
  });
});
