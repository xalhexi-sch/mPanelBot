const { loadConfig } = require("./config");
const { DatabaseManager } = require("./database");
const { LinkRepository } = require("./database/repositories/linkRepository");
const { DedupeRepository } = require("./database/repositories/dedupeRepository");
const { StatsRepository } = require("./database/repositories/statsRepository");
const { StatsService } = require("./services/statsService");
const { SteamAvatarService } = require("./services/steamAvatar");
const { LivePanels } = require("./discord/livePanels");
const { GuildRepository } = require("./database/repositories/guildRepository");
const { AuditRepository } = require("./database/repositories/auditRepository");
const { SnapshotRepository } = require("./database/repositories/snapshotRepository");

const { GameWebSocketServer } = require("./websocket/server");
const { createEnvelope } = require("./websocket/protocol");
const { MessageRouter } = require("./websocket/router");
const { createHealthServer } = require("./http/healthServer");
const { PterodactylClient } = require("./pterodactyl/client");

const { LinkService } = require("./services/linkService");
const { ModerationService } = require("./services/moderationService");

const { DiscordBotClient } = require("./discord/client");
const { RoleSyncManager } = require("./discord/roles/roleSync");
const { DiscordLogger } = require("./discord/logs/discordLogger");
const { RaidNotifier } = require("./discord/raid/raidNotifier");
const { ChatRelay } = require("./discord/relay/chatRelay");

async function main() {
  console.log("==================================================");
  console.log("    mPanel Unturned Discord Bot & Backend v1.0    ");
  console.log("==================================================");

  // 1. Load config
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`❌ Startup Error: ${err.message}`);
    process.exit(1);
  }

  // 2. Initialize Database & Repositories
  console.log(`[database] Initializing SQLite database at: ${config.storage.sqlitePath}`);
  const dbManager = new DatabaseManager(config.storage.sqlitePath);
  const linkRepo = new LinkRepository(dbManager);
  const dedupeRepo = new DedupeRepository(dbManager);
  const statsRepo = new StatsRepository(dbManager);
  const avatars = new SteamAvatarService();
  const statsService = new StatsService({ statsRepo, mysqlConfig: config.integrations.mysql });
  console.log(`[stats] Player stats source: ${statsService.source}`);
  const guildRepo = new GuildRepository(dbManager, config.security.encryptionKey, [config.network.apiKey]);
  const migrated = guildRepo.migrateEncryption();
  if (migrated > 0) console.log("[security] Re-encrypted " + migrated + " stored secret(s) with the dedicated key.");
  const auditRepo = new AuditRepository(dbManager);
  const snapshotRepo = new SnapshotRepository(dbManager);

  // 3. Optional Pterodactyl Integration
  const pterodactylClient = new PterodactylClient(config.integrations.pterodactyl);
  if (pterodactylClient.isConfigured()) {
    console.log("[ptero] Pterodactyl integration enabled for fallback execution.");
  } else {
    console.log("[ptero] Pterodactyl integration disabled (default).");
  }

  // 4. WebSocket Server & HTTP Health Server
  const wsServer = new GameWebSocketServer({
    apiKey: config.network.apiKey,
    heartbeatIntervalMs: config.network.heartbeatIntervalMs,
    maxPayloadSizeBytes: config.network.maxPayloadSizeBytes,
    serverKeys: config.network.serverKeys,
    messageRatePerSec: config.network.messageRatePerSec,
    messageBurst: config.network.messageBurst,
  });

  const healthServer = createHealthServer({
    wsServer,
    host: config.network.bindAddress,
    port: config.network.port,
  });

  // 5. Services
  const moderationService = new ModerationService({
    wsServer,
    pterodactylClient,
    auditRepo,
  });

  let roleSyncManager = null;
  const linkService = new LinkService({
    linkRepo,
    onLinkCompleted: async ({ discordId, guild, steamId, serverId, code }) => {
      // Tell the player in-game that the link succeeded (best effort; the plugin may be offline)
      try {
        const session = serverId ? wsServer.getSession(serverId) : null;
        if (session && !session.isClosed) {
          session.send(createEnvelope({ kind: "event", type: "player.link.completed", serverId, payload: { steamId, discordId, code } }));
        }
      } catch (err) {
        console.warn(`[link] Could not notify game server: ${err.message}`);
      }

      if (roleSyncManager && guild) {
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) {
          await roleSyncManager.syncMember(member);
        }
      }
    },
  });

  // 6. Discord Bot Client & Modules
  const discordBot = new DiscordBotClient({
    token: config.discord.token,
    clientId: config.discord.clientId,
    guildRepo,
    linkRepo,
    statsRepo,
    statsService,
    snapshotRepo,
    moderationService,
    linkService,
  });

  discordBot.livePanels = new LivePanels({
    client: discordBot.client,
    guildRepo,
    snapshotRepo,
    statsService,
    wsServer,
  });

  roleSyncManager = new RoleSyncManager({
    linkRepo,
    guildRepo,
    discordClient: discordBot.client,
  });
  discordBot.roleSyncManager = roleSyncManager;

  const discordLogger = new DiscordLogger({
    discordClient: discordBot.client,
    guildRepo,
    avatars,
    snapshotRepo,
    linkRepo,
  });
  discordBot.discordLogger = discordLogger;

  const raidNotifier = new RaidNotifier({
    discordClient: discordBot.client,
    linkRepo,
    guildRepo,
  });
  discordBot.raidNotifier = raidNotifier;

  const chatRelay = new ChatRelay({
    avatars,
    discordClient: discordBot.client,
    wsServer,
    guildRepo,
  });
  discordBot.chatRelay = chatRelay;
  discordBot.wsServer = wsServer;

  // 7. Message Router
  const messageRouter = new MessageRouter({
    dedupeRepo,
    snapshotRepo,
    statsRepo,
    linkService,
    discordLogger,
    raidNotifier,
    chatRelay,
    discordClient: discordBot,
  });

  wsServer.on("envelope", (session, envelope) => {
    messageRouter.handleEnvelope(session, envelope);
  });

  wsServer.on("server_connected", (session) => {
    console.log(`[websocket] Server connected: ${session.serverId} (${session.serverName}, plugin v${session.pluginVersion}) from ${session.remoteAddress}`);
  });

  wsServer.on("server_disconnected", (serverId) => {
    console.log(`[websocket] Server disconnected: ${serverId}`);
  });

  wsServer.on("auth_failed", ({ remoteAddress, blocked }) => {
    console.warn("[websocket] Unauthorized connection attempt rejected from " + remoteAddress + (blocked ? " (address temporarily blocked)" : ""));
  });

  wsServer.on("rate_limited", ({ remoteAddress, serverId }) => {
    console.warn("[websocket] Rate limit exceeded by " + (serverId || remoteAddress) + "; connection closed.");
  });

  // 8. Start HTTP / WebSocket listener
  healthServer.listen(config.network.port, config.network.bindAddress, () => {
    console.log(`[network] WebSocket and Health server listening on ${config.network.bindAddress}:${config.network.port}`);
  });

  // 9. Login Discord Client
  console.log("[discord] Logging into Discord gateway...");
  try {
    await discordBot.start();
  } catch (err) {
    console.error(`[discord] Failed to login to Discord: ${err.message}`);
    if (/intent/i.test(err.message)) {
      console.error("[discord] Enable the 'Server Members' and 'Message Content' privileged intents: Developer Portal > your app > Bot.");
    }
    console.warn("[discord] Bot will continue hosting the WebSocket server for game connections.");
  }

  // 10. Periodic Maintenance
  const maintenanceTimer = setInterval(() => {
    try {
      linkRepo.purgeExpiredCodes();
      dedupeRepo.pruneOldEvents(7);
    } catch (err) {
      console.warn(`[maintenance] Cleanup error: ${err.message}`);
    }
  }, 10 * 60 * 1000); // Every 10 min

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[system] Received ${signal}. Shutting down gracefully...`);
    clearInterval(maintenanceTimer);

    try {
      wsServer.close();
      healthServer.close();
      await discordBot.stop().catch(() => {});
      await statsService.close().catch(() => {});
      dbManager.close();
      console.log("[system] Shutdown complete. Goodbye!");
      process.exit(0);
    } catch (err) {
      console.error("[system] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}

module.exports = { main };
