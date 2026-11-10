const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ActivityType,
} = require("discord.js");

const { buildSetupCommand, handleSetupInteraction } = require("./commands/setup");
const { buildLinkCommand, buildUnlinkCommand, handleLinkInteraction, handleUnlinkInteraction } = require("./commands/link");
const {
  buildStatsCommand,
  buildRankingCommand,
  buildCompareCommand,
  handleStatsInteraction,
  handleRankingInteraction,
  handleCompareInteraction,
} = require("./commands/stats");
const {
  buildBanCommand,
  buildMuteCommand,
  buildWarnCommand,
  buildKickCommand,
  buildUnbanCommand,
  buildUnmuteCommand,
  handleModerationInteraction,
} = require("./commands/moderation");
const { buildConsoleCommand, handleConsoleInteraction } = require("./commands/console");
const { buildStatusCommand, handleStatusInteraction } = require("./commands/status");

class DiscordBotClient {
  constructor({ token, clientId, guildRepo, linkRepo, statsRepo, snapshotRepo, moderationService, linkService }) {
    this.token = token;
    this.clientId = clientId;
    this.guildRepo = guildRepo;
    this.linkRepo = linkRepo;
    this.statsRepo = statsRepo;
    this.snapshotRepo = snapshotRepo;
    this.moderationService = moderationService;
    this.linkService = linkService;

    this.roleSyncManager = null;
    this.chatRelay = null;
    this.discordLogger = null;
    this.raidNotifier = null;
    this.wsServer = null;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    this.setupListeners();
  }

  getCommandBuilders() {
    return [
      buildSetupCommand(),
      buildLinkCommand(),
      buildUnlinkCommand(),
      buildStatsCommand(),
      buildRankingCommand(),
      buildCompareCommand(),
      buildBanCommand(),
      buildMuteCommand(),
      buildWarnCommand(),
      buildKickCommand(),
      buildUnbanCommand(),
      buildUnmuteCommand(),
      buildConsoleCommand(),
      buildStatusCommand(),
    ];
  }

  async deployCommands() {
    if (!this.clientId) {
      console.warn("[discord] Warning: clientId not configured; skipping global slash commands registration.");
      return;
    }

    const rest = new REST({ version: "10" }).setToken(this.token);
    const commandsJson = this.getCommandBuilders().map((c) => c.toJSON());

    try {
      console.log(`[discord] Registering ${commandsJson.length} application (/) commands...`);
      await rest.put(Routes.applicationCommands(this.clientId), {
        body: commandsJson,
      });
      console.log("[discord] Successfully reloaded application (/) commands.");
    } catch (err) {
      console.error(`[discord] Failed to register slash commands: ${err.message}`);
    }
  }

  setupListeners() {
    this.client.once("ready", async () => {
      console.log(`[discord] Logged in as ${this.client.user.tag}`);
      this.updatePresence();

      // Register slash commands if clientId is provided
      if (this.clientId) {
        await this.deployCommands();
      }

      // Initial sweep of role sync across guilds
      if (this.roleSyncManager) {
        for (const guild of this.client.guilds.cache.values()) {
          this.roleSyncManager.syncGuild(guild).catch(() => {});
        }
      }
    });

    this.client.on("guildMemberAdd", async (member) => {
      if (this.roleSyncManager) {
        await this.roleSyncManager.syncMember(member);
      }
    });

    this.client.on("messageCreate", async (message) => {
      if (this.chatRelay) {
        await this.chatRelay.handleDiscordMessage(message);
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleInteraction(interaction);
    });
  }

  updatePresence() {
    if (!this.client.user) return;

    const snapshots = this.snapshotRepo ? this.snapshotRepo.getAllSnapshots() : [];
    let totalOnline = 0;
    let totalMax = 0;

    for (const s of snapshots) {
      totalOnline += s.onlineCount || 0;
      totalMax += s.maxPlayers || 0;
    }

    if (totalMax > 0) {
      this.client.user.setActivity(`${totalOnline}/${totalMax} Players`, {
        type: ActivityType.Watching,
      });
    } else {
      this.client.user.setActivity("Unturned Servers", {
        type: ActivityType.Watching,
      });
    }
  }

  async handleInteraction(interaction) {
    const cmd = interaction.commandName;
    const context = {
      guildRepo: this.guildRepo,
      linkRepo: this.linkRepo,
      statsRepo: this.statsRepo,
      snapshotRepo: this.snapshotRepo,
      moderationService: this.moderationService,
      linkService: this.linkService,
      roleSyncManager: this.roleSyncManager,
      wsServer: this.wsServer,
    };

    try {
      if (cmd === "setup") {
        return await handleSetupInteraction(interaction, context);
      }
      if (cmd === "link") {
        return await handleLinkInteraction(interaction, context);
      }
      if (cmd === "unlink") {
        return await handleUnlinkInteraction(interaction, context);
      }
      if (cmd === "stats") {
        return await handleStatsInteraction(interaction, context);
      }
      if (cmd === "ranking") {
        return await handleRankingInteraction(interaction, context);
      }
      if (cmd === "compare") {
        return await handleCompareInteraction(interaction, context);
      }
      if (["ban", "mute", "warn", "kick", "unban", "unmute"].includes(cmd)) {
        return await handleModerationInteraction(interaction, context);
      }
      if (cmd === "run") {
        return await handleConsoleInteraction(interaction, context);
      }
      if (cmd === "status") {
        return await handleStatusInteraction(interaction, context);
      }
    } catch (err) {
      console.error(`[discord] Error handling command /${cmd}:`, err);
      const reply = { content: `❌ Error executing command: ${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  }

  async start() {
    return this.client.login(this.token);
  }

  async stop() {
    return this.client.destroy();
  }
}

module.exports = { DiscordBotClient };
