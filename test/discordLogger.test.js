const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { DiscordLogger, sanitizeLoggedCommand, formatDuration } = require("../src/discord/logs/discordLogger");
const { MessageRouter } = require("../src/websocket/router");

describe("DiscordLogger Unit & Integration Tests", () => {
  let db;
  let guildRepo;
  let sentMessages;
  let fakeChannel;
  let fakeGuild;
  let fakeClient;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    guildRepo = new GuildRepository(db);
    sentMessages = [];

    fakeChannel = {
      id: "channel-123",
      isTextBased: () => true,
      send: async (payload) => {
        sentMessages.push(payload);
        return { id: "msg-1" };
      },
    };

    fakeGuild = {
      id: "guild-1",
      channels: {
        cache: new Map([["channel-123", fakeChannel]]),
        fetch: async (id) => (id === "channel-123" ? fakeChannel : null),
      },
    };

    fakeClient = {
      guilds: {
        cache: new Map([["guild-1", fakeGuild]]),
        fetch: async (id) => (id === "guild-1" ? fakeGuild : null),
      },
      channels: {
        fetch: async (id) => (id === "channel-123" ? fakeChannel : null),
      },
    };
  });

  it("should verify require('./discord/logs/discordLogger') resolves and exports DiscordLogger", () => {
    const mod = require("../src/discord/logs/discordLogger");
    assert.strictEqual(typeof mod.DiscordLogger, "function");
  });

  describe("Player Connection and Disconnection Logging", () => {
    it("should log player connected to joinLeaveChannelId with proper embed", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await logger.logPlayerConnected({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        ping: 42,
      });

      assert.strictEqual(sentMessages.length, 1);
      const embed = sentMessages[0].embeds[0].data;
      assert.strictEqual(embed.author.name, "SurvivorOne: joined the server");
      assert.strictEqual(embed.color, 0x57f287);
      assert.strictEqual(embed.footer.text, "survival-1");
      assert.ok(embed.author.url.endsWith("76561198000000001"));
    });

    it("should log player disconnected to joinLeaveChannelId with formatted duration", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await logger.logPlayerDisconnected({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        durationSeconds: 3665,
      });

      assert.strictEqual(sentMessages.length, 1);
      const embed = sentMessages[0].embeds[0].data;
      assert.strictEqual(embed.author.name, "SurvivorOne: left the server (played 1h 1m 5s)");
      assert.strictEqual(embed.color, 0xd41111);
    });
  });

  describe("Command Logging and Sensitive Data Redaction", () => {
    it("should log command execution to commandLogChannelId", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        commandLogChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await logger.logCommand({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        command: "/kit pvp",
      });

      assert.strictEqual(sentMessages.length, 1);
      const embed = sentMessages[0].embeds[0].data;
      assert.strictEqual(embed.author.name, "SurvivorOne: /kit pvp");
      assert.strictEqual(embed.color, 0xd41111);
    });

    it("should redact sensitive command arguments like /link and passwords (SEC-12)", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        commandLogChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      // Test link code redaction
      await logger.logCommand({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        command: "/link 884920",
      });

      // Test login password redaction
      await logger.logCommand({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        command: "/login mySecretPassword123",
      });

      // Test high-entropy token redaction
      await logger.logCommand({
        serverId: "survival-1",
        steamId: "76561198000000001",
        playerName: "SurvivorOne",
        command: "/apikey d8a7f9b0c1e234567890abcdef1234",
      });

      assert.strictEqual(sentMessages.length, 3);
      const cmd1 = sentMessages[0].embeds[0].data.author.name;
      const cmd2 = sentMessages[1].embeds[0].data.author.name;
      const cmd3 = sentMessages[2].embeds[0].data.author.name;

      assert.ok(cmd1.endsWith("/link [REDACTED]"));
      assert.ok(cmd2.endsWith("/login [REDACTED]"));
      assert.ok(cmd3.includes("[REDACTED]"));
      assert.ok(!cmd3.includes("d8a7f9b0c1e234567890abcdef1234"));
    });

    it("should sanitize helper function sanitizeLoggedCommand directly", () => {
      assert.strictEqual(sanitizeLoggedCommand("/password secretPass"), "/password [REDACTED]");
      assert.strictEqual(sanitizeLoggedCommand("/register myPass1"), "/register [REDACTED]");
      assert.strictEqual(sanitizeLoggedCommand("/auth SomeToken123"), "/auth [REDACTED]");
      assert.strictEqual(sanitizeLoggedCommand(""), "");
    });
  });

  describe("Punishment Logging", () => {
    it("should log ban punishment to punishmentLogChannelId with red embed", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        punishmentLogChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await logger.logPunishment({
        serverId: "survival-1",
        adminSteamId: "76561198000000000",
        adminName: "AdminUser",
        action: "ban",
        targetSteamId: "76561198000000099",
        targetName: "Cheater",
        reason: "Speed hacking",
        duration: "7d",
      });

      assert.strictEqual(sentMessages.length, 1);
      const embed = sentMessages[0].embeds[0].data;
      assert.strictEqual(embed.title, "🔨 Moderation: BAN");
      assert.strictEqual(embed.color, 0xed4245);

      const fields = embed.fields;
      assert.ok(fields.some((f) => f.name === "Action" && f.value.includes("ban")));
      assert.ok(fields.some((f) => f.name === "Target" && f.value.includes("Cheater")));
      assert.ok(fields.some((f) => f.name === "Target Steam64" && f.value.includes("76561198000000099")));
      assert.ok(fields.some((f) => f.name === "Admin" && f.value.includes("AdminUser")));
      assert.ok(fields.some((f) => f.name === "Duration" && f.value.includes("7d")));
      assert.ok(fields.some((f) => f.name === "Reason" && f.value.includes("Speed hacking")));
    });

    it("should use distinct colors for different punishment actions (kick, mute, warn, unban)", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        punishmentLogChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await logger.logPunishment({ action: "kick", targetName: "P1" });
      await logger.logPunishment({ action: "warn", targetName: "P2" });
      await logger.logPunishment({ action: "mute", targetName: "P3" });
      await logger.logPunishment({ action: "unban", targetName: "P4" });

      assert.strictEqual(sentMessages.length, 4);
      assert.strictEqual(sentMessages[0].embeds[0].data.color, 0xfee75c); // Kick: Yellow
      assert.strictEqual(sentMessages[1].embeds[0].data.color, 0xfee75c); // Warn: Yellow
      assert.strictEqual(sentMessages[2].embeds[0].data.color, 0xeb459e); // Mute: Fuchsia
      assert.strictEqual(sentMessages[3].embeds[0].data.color, 0x57f287); // Unban: Green
    });
  });

  describe("Error Handling & Resilience", () => {
    it("should handle missing channel mappings gracefully without sending or throwing", async () => {
      // Guild configured without any channel mappings
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: null,
        commandLogChannelId: null,
        punishmentLogChannelId: null,
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await assert.doesNotReject(async () => {
        await logger.logPlayerConnected({ serverId: "s1", steamId: "123" });
        await logger.logPlayerDisconnected({ serverId: "s1", steamId: "123" });
        await logger.logCommand({ serverId: "s1", command: "/help" });
        await logger.logPunishment({ serverId: "s1", action: "kick" });
      });

      assert.strictEqual(sentMessages.length, 0);
    });

    it("should handle unavailable guilds gracefully", async () => {
      guildRepo.upsertGuildConfig("guild-999-missing", {
        joinLeaveChannelId: "channel-123",
      });

      const clientWithoutGuild = {
        guilds: {
          cache: new Map(),
          fetch: async () => null,
        },
      };

      const logger = new DiscordLogger({
        discordClient: clientWithoutGuild,
        guildRepo,
      });

      await assert.doesNotReject(async () => {
        await logger.logPlayerConnected({ serverId: "s1", steamId: "123" });
      });

      assert.strictEqual(sentMessages.length, 0);
    });

    it("should handle deleted or missing channels gracefully", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: "deleted-channel-404",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await assert.doesNotReject(async () => {
        await logger.logPlayerConnected({ serverId: "s1", steamId: "123" });
      });

      assert.strictEqual(sentMessages.length, 0);
    });

    it("should ignore non-text channels safely", async () => {
      const nonTextChannel = {
        id: "voice-123",
        isTextBased: () => false,
        send: async () => {
          throw new Error("Cannot send to voice channel");
        },
      };

      fakeGuild.channels.cache.set("voice-123", nonTextChannel);
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: "voice-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await assert.doesNotReject(async () => {
        await logger.logPlayerConnected({ serverId: "s1", steamId: "123" });
      });

      assert.strictEqual(sentMessages.length, 0);
    });

    it("should catch Discord API errors (e.g. 50001 Missing Permissions) without throwing", async () => {
      const failingChannel = {
        id: "channel-fail",
        isTextBased: () => true,
        send: async () => {
          const err = new Error("DiscordAPIError[50013]: Missing Permissions");
          err.code = 50013;
          throw err;
        },
      };

      fakeGuild.channels.cache.set("channel-fail", failingChannel);
      guildRepo.upsertGuildConfig("guild-1", {
        commandLogChannelId: "channel-fail",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      await assert.doesNotReject(async () => {
        await logger.logCommand({ serverId: "s1", command: "/kit" });
      });
    });

    it("should never crash when client or guildRepo is undefined/null", async () => {
      const emptyLogger = new DiscordLogger();

      await assert.doesNotReject(async () => {
        await emptyLogger.logPlayerConnected(null);
        await emptyLogger.logPlayerDisconnected(null);
        await emptyLogger.logCommand(null);
        await emptyLogger.logPunishment(null);
      });
    });
  });

  describe("Integration with MessageRouter", () => {
    it("should receive events from MessageRouter and invoke corresponding logger methods", async () => {
      guildRepo.upsertGuildConfig("guild-1", {
        joinLeaveChannelId: "channel-123",
        commandLogChannelId: "channel-123",
        punishmentLogChannelId: "channel-123",
      });

      const logger = new DiscordLogger({
        discordClient: fakeClient,
        guildRepo,
      });

      const router = new MessageRouter({
        dedupeRepo: { isEventProcessed: () => false, markEventProcessed: () => true },
        snapshotRepo: { saveSnapshot: () => {} },
        statsRepo: { updatePlayerSeen: () => {}, recordPlaytime: () => {} },
        linkService: {},
        discordLogger: logger,
        raidNotifier: null,
        chatRelay: null,
        discordClient: null,
      });

      const session = {
        serverId: "survival-1",
        send: () => {},
      };

      // 1. player.connected
      await router.handleEnvelope(session, {
        v: 1,
        id: "e1",
        kind: "event",
        type: "player.connected",
        serverId: "survival-1",
        payload: { steamId: "76561198000000001", playerName: "P1", ping: 50 },
      });

      // 2. player.disconnected
      await router.handleEnvelope(session, {
        v: 1,
        id: "e2",
        kind: "event",
        type: "player.disconnected",
        serverId: "survival-1",
        payload: { steamId: "76561198000000001", playerName: "P1", durationSeconds: 600 },
      });

      // 3. log.command
      await router.handleEnvelope(session, {
        v: 1,
        id: "e3",
        kind: "event",
        type: "log.command",
        serverId: "survival-1",
        payload: { steamId: "76561198000000001", playerName: "P1", command: "/help" },
      });

      // 4. log.punishment
      await router.handleEnvelope(session, {
        v: 1,
        id: "e4",
        kind: "event",
        type: "log.punishment",
        serverId: "survival-1",
        payload: {
          adminSteamId: "76561198000000000",
          adminName: "Mod",
          action: "warn",
          targetSteamId: "76561198000000001",
          targetName: "P1",
          reason: "Spamming",
        },
      });

      assert.strictEqual(sentMessages.length, 4);
      assert.strictEqual(sentMessages[0].embeds[0].data.author.name.endsWith("joined the server"), true);
      assert.strictEqual(sentMessages[1].embeds[0].data.author.name.includes("left the server"), true);
      assert.strictEqual(sentMessages[2].embeds[0].data.author.name.includes(": "), true);
      assert.strictEqual(sentMessages[3].embeds[0].data.title, "🔨 Moderation: WARN");
    });
  });
});
