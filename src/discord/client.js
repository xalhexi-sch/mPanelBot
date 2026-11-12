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
  buildFarmbotsCommand,
  handleFarmbotsInteraction,
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
const { handleSteamLinkMessage } = require("./steamLinks");

class DiscordBotClient {
  constructor({ token, clientId, guildPolicy = null, guildRepo, linkRepo, statsRepo, statsService, snapshotRepo, moderationService, linkService, steam = null }) {
    this.token = token;
    this.steam = steam;
    this.clientId = clientId;
    this.guildPolicy = guildPolicy;
    this._lastActivity = null;
    this.guildRepo = guildRepo;
    this.linkRepo = linkRepo;
    this.statsRepo = statsRepo;
    this.statsService = statsService;
    this.livePanels = null;
    this.snapshotRepo = snapshotRepo;
    this.moderationService = moderationService;
    this.linkService = linkService;

    this.roleSyncManager = null;
    this.chatRelay = null;
    this.discordLogger = null;
    this.raidNotifier = null;
    this.wsServer = null;

    this.client = new Client({
      // Never let relayed/user text ping anyone; code that really wants a ping passes explicit `allowedMentions.users`.
      allowedMentions: { parse: [], repliedUser: false },
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
      buildFarmbotsCommand(),
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
      this.leaveForeignGuilds();
      if (this.livePanels) this.livePanels.start();

      // Register slash commands; fall back to the application id Discord reports for this token
      if (!this.clientId) this.clientId = this.client.application?.id || null;
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

    this.client.on("guildCreate", (guild) => {
      if (this.guildPolicy && !this.guildPolicy.isAllowed(guild.id) && !this.guildPolicy.isUnclaimed) {
        console.warn(`[discord] Leaving unauthorised guild ${guild.id}. Turn off "Public Bot" in the Developer Portal to stop invites.`);
        guild.leave().catch(() => {});
      }
    });

    this.client.on("guildMemberAdd", async (member) => {
      try {
        if (this.roleSyncManager && this.isGuildAllowed(member.guild?.id)) {
          await this.roleSyncManager.syncMember(member);
        }
      } catch (err) {
        console.warn(`[discord] guildMemberAdd handler failed: ${err.message}`);
      }
    });

    this.client.on("messageCreate", async (message) => {
      // DMs have no guild: only guild messages are subject to the guild policy and chat relay.
      if (message.guildId) {
        if (!this.isGuildAllowed(message.guildId)) return;
        try {
          if (this.chatRelay) await this.chatRelay.handleDiscordMessage(message);
        } catch (err) {
          console.warn(`[discord] messageCreate handler failed: ${err.message}`);
        }
      }
      try {
        await handleSteamLinkMessage(message, this.steam);
      } catch (err) {
        console.warn(`[discord] steam link reply failed: ${err.message}`);
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await this.handleInteraction(interaction);
      } catch (err) {
        console.warn(`[discord] interaction handler failed: ${err.message}`);
      }
    });
  }

  /** Without a policy (unit tests, legacy wiring) every guild is allowed. */
  isGuildAllowed(guildId) {
    return !this.guildPolicy || this.guildPolicy.isAllowed(guildId);
  }

  leaveForeignGuilds() {
    if (!this.guildPolicy || this.guildPolicy.isUnclaimed) return;
    for (const guild of this.client.guilds.cache.values()) {
      if (!this.guildPolicy.isAllowed(guild.id)) {
        console.warn(`[discord] Leaving unauthorised guild ${guild.id}.`);
        guild.leave().catch(() => {});
      }
    }
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

    const text = totalMax > 0 ? `${totalOnline}/${totalMax} Players` : "Unturned Servers";
    // Gateway presence updates are rate limited; skip the call when nothing changed.
    if (text === this._lastActivity) return;
    this._lastActivity = text;
    this.client.user.setActivity(text, { type: ActivityType.Watching });
  }

  async handleInteraction(interaction) {
    const cmd = interaction.commandName;

    // Only the operator's guild(s) may drive the bot. The first /setup by an Administrator claims an unclaimed bot.
    if (this.guildPolicy) {
      const isAdmin = interaction.memberPermissions?.has?.("Administrator");
      const claimed = cmd === "setup" && isAdmin && interaction.guildId && this.guildPolicy.claimIfUnclaimed(interaction.guildId);
      if (!claimed && !this.guildPolicy.isAllowed(interaction.guildId)) {
        return interaction.reply({ content: "❌ This bot is not authorised for this server.", ephemeral: true }).catch(() => {});
      }
    }
    const context = {
      guildRepo: this.guildRepo,
      linkRepo: this.linkRepo,
      statsRepo: this.statsRepo,
      statsService: this.statsService,
      livePanels: this.livePanels,
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
      if (cmd === "farmbots") {
        return await handleFarmbotsInteraction(interaction, context);
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
    if (this.livePanels) this.livePanels.stop();
    return this.client.destroy();
  }
}

module.exports = { DiscordBotClient };
