const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { ChatRelay, DEFAULT_AVATAR_URL } = require("../src/discord/relay/chatRelay");
const { WebhookDeliveryQueue } = require("../src/discord/relay/webhookDeliveryQueue");
const { buildSetupCommand, handleSetupInteraction } = require("../src/discord/commands/setup");
const { encryptText, decryptText, redactWebhookUrl } = require("../src/utils/security");
const { PermissionFlagsBits } = require("discord.js");

describe("ChatRelay Architecture & Webhook Redesign Tests", () => {
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
    guildRepo = new GuildRepository(db, "test-master-api-key-12345");

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

  describe("Security: Encryption at Rest & Token Redaction", () => {
    it("should encrypt and decrypt webhook URLs correctly using AES-256-GCM", () => {
      const secret = "secret-key-xyz";
      const webhookUrl = "https://discord.com/api/webhooks/1234567890/SECRET_TOKEN_ABC";
      const encrypted = encryptText(webhookUrl, secret);

      assert.ok(encrypted.startsWith("enc:"), "Encrypted string should have 'enc:' prefix");
      assert.ok(!encrypted.includes("SECRET_TOKEN_ABC"), "Encrypted string must not contain token");

      const decrypted = decryptText(encrypted, secret);
      assert.strictEqual(decrypted, webhookUrl);
    });

    it("should safely redact webhook URLs and tokens from log strings", () => {
      const leakedLog = "Error sending to https://discord.com/api/webhooks/987654321098765432/SuperSecretToken123 with status 500";
      const sanitized = redactWebhookUrl(leakedLog);

      assert.ok(!sanitized.includes("SuperSecretToken123"), "Token must be stripped from log");
      assert.ok(sanitized.includes("https://discord.com/api/webhooks/987654321098765432/••••••••"));
    });

    it("should encrypt webhook URLs when saved in GuildRepository and decrypt on load", () => {
      const originalUrl = "https://discord.com/api/webhooks/111222333/SecTokenXYZ";
      guildRepo.upsertGuildConfig("guild-sec", {
        chatWebhookUrl: originalUrl,
        chatChannelId: "ch-sec-1",
      });

      // Verify raw DB row contains ciphertext, not plaintext
      const row = db.prepare("SELECT chat_webhook_url FROM guild_configs WHERE guild_id = 'guild-sec'").get();
      assert.ok(row.chat_webhook_url.startsWith("enc:"), "Database must store encrypted ciphertext");
      assert.ok(!row.chat_webhook_url.includes("SecTokenXYZ"), "Database must never store raw webhook token");

      // Verify repository transparently decrypts for authenticated callers
      const loaded = guildRepo.getGuildConfig("guild-sec");
      assert.strictEqual(loaded.chatWebhookUrl, originalUrl);
    });
  });

  describe("Unturned -> Discord Webhook Delivery & Zero Persistence", () => {
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

  describe("Webhook Queue Reliability & Rate Limiting", () => {
    it("should drop oldest message when in-memory queue exceeds capacity (backpressure)", async () => {
      let resolveSend;
      const slowWebhook = {
        send: () => new Promise((resolve) => { resolveSend = resolve; }),
      };

      const queue = new WebhookDeliveryQueue({ maxCapacity: 3 });

      // Enqueue 5 items (1 in flight, 3 buffered, 1 overflow drop)
      queue.enqueue({ webhookClient: slowWebhook, guildId: "g1", payload: { content: "msg1" } });
      queue.enqueue({ webhookClient: slowWebhook, guildId: "g1", payload: { content: "msg2" } });
      queue.enqueue({ webhookClient: slowWebhook, guildId: "g1", payload: { content: "msg3" } });
      queue.enqueue({ webhookClient: slowWebhook, guildId: "g1", payload: { content: "msg4" } });
      queue.enqueue({ webhookClient: slowWebhook, guildId: "g1", payload: { content: "msg5" } }); // Triggers overflow drop

      assert.strictEqual(queue.droppedCount, 1, "Must increment dropped count on overflow");
      assert.ok(queue.size <= 3, "Queue size must never exceed capacity");

      // Release pending promise
      if (resolveSend) resolveSend({ id: "done" });
    });
  });

  describe("/setup channels Automatic Webhook Management", () => {
    it("should reject setup when ManageWebhooks permission is missing", async () => {
      let replyContent = null;
      const mockChannel = {
        id: "channel-nowh",
        permissionsFor: () => ({
          has: (perm) => perm !== PermissionFlagsBits.ManageWebhooks,
        }),
      };

      const interaction = {
        guild: { id: "guild-noperm", members: { me: {} } },
        options: {
          getSubcommand: () => "channels",
          getChannel: (name) => (name === "chat_channel" ? mockChannel : null),
        },
        reply: async (obj) => { replyContent = obj.content; },
      };

      await handleSetupInteraction(interaction, { guildRepo });
      assert.ok(replyContent.includes("Manage Webhooks"), "Must report missing Manage Webhooks permission");
    });

    it("should reuse existing mPanel Chat Relay webhook and prevent duplicates", async () => {
      let createdNew = false;
      let replyContent = null;

      const existingWebhook = {
        name: "mPanel Chat Relay",
        url: "https://discord.com/api/webhooks/reuse/secret_token",
        owner: { id: "bot-user-123" },
      };

      const mockChannel = {
        id: "channel-reuse",
        permissionsFor: () => ({
          has: () => true,
        }),
        fetchWebhooks: async () => [existingWebhook],
        createWebhook: async () => {
          createdNew = true;
          return { name: "duplicate", url: "https://discord.com/api/webhooks/dup/dup" };
        },
      };

      const interaction = {
        client: fakeClient,
        guild: { id: "guild-reuse", members: { me: {} } },
        options: {
          getSubcommand: () => "channels",
          getChannel: (name) => (name === "chat_channel" ? mockChannel : null),
        },
        reply: async (obj) => { replyContent = obj.content; },
      };

      await handleSetupInteraction(interaction, { guildRepo });

      assert.strictEqual(createdNew, false, "Must not create duplicate webhook if one already exists");
      assert.ok(replyContent.includes("reused existing webhook"));

      // Verify stored in DB
      const cfg = guildRepo.getGuildConfig("guild-reuse");
      assert.strictEqual(cfg.chatWebhookUrl, existingWebhook.url);
    });

    it("should automatically create new webhook when none exists", async () => {
      let created = false;
      let replyContent = null;

      const mockChannel = {
        id: "channel-fresh",
        permissionsFor: () => ({
          has: () => true,
        }),
        fetchWebhooks: async () => [],
        createWebhook: async (options) => {
          created = true;
          assert.strictEqual(options.name, "mPanel Chat Relay");
          return { name: options.name, url: "https://discord.com/api/webhooks/fresh/new_token" };
        },
      };

      const interaction = {
        client: fakeClient,
        guild: { id: "guild-fresh", members: { me: {} } },
        options: {
          getSubcommand: () => "channels",
          getChannel: (name) => (name === "chat_channel" ? mockChannel : null),
        },
        reply: async (obj) => { replyContent = obj.content; },
      };

      await handleSetupInteraction(interaction, { guildRepo });

      assert.strictEqual(created, true, "Must create new webhook when none exists");
      assert.ok(replyContent.includes("created new webhook"));

      const cfg = guildRepo.getGuildConfig("guild-fresh");
      assert.strictEqual(cfg.chatWebhookUrl, "https://discord.com/api/webhooks/fresh/new_token");
    });

    it("should never reveal webhook URL or token in /setup show output", async () => {
      guildRepo.upsertGuildConfig("guild-show", {
        chatChannelId: "ch-123",
        chatWebhookUrl: "https://discord.com/api/webhooks/123/VERY_SECRET_TOKEN_HERE",
      });

      let embedOutput = null;
      const interaction = {
        guild: { id: "guild-show", name: "Survival Network" },
        options: {
          getSubcommand: () => "show",
        },
        reply: async (obj) => { embedOutput = obj.embeds[0]; },
      };

      await handleSetupInteraction(interaction, { guildRepo });

      const fieldsJson = JSON.stringify(embedOutput.data.fields);
      assert.ok(!fieldsJson.includes("VERY_SECRET_TOKEN_HERE"), "Token must never appear in /setup show");
      assert.ok(fieldsJson.includes("Configured (automatic)"), "Must display safe configured label");
    });
  });
});
