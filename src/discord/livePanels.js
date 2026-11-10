/**
 * Auto-updating status + leaderboard messages (one persistent message each, edited in place).
 * Channel/message IDs live in SQLite guild config (`/setup panels`). If an admin deletes the message
 * the panel simply posts a fresh one. Unchanged content is never re-sent, which keeps us far from rate limits.
 */
const { buildStatusEmbeds, buildLeaderboardEmbed } = require("./views");

class LivePanels {
  constructor({ client, guildRepo, snapshotRepo, statsService, wsServer, statusSeconds = 30, leaderboardSeconds = 60, logger = console }) {
    this.client = client;
    this.guildRepo = guildRepo;
    this.snapshotRepo = snapshotRepo;
    this.statsService = statsService;
    this.wsServer = wsServer;
    this.statusMs = Math.max(15, statusSeconds) * 1000;
    this.leaderboardMs = Math.max(30, leaderboardSeconds) * 1000;
    this.logger = logger;
    this.timers = [];
    this.lastHash = new Map(); // `${guildId}:status|leaderboard` -> serialized payload
    this.tick = 0;
    this.inFlight = new Map();
  }

  start() {
    this.stop();
    this.timers.push(setInterval(() => this.refreshAll("status").catch(() => {}), this.statusMs));
    this.timers.push(setInterval(() => this.refreshAll("leaderboard").catch(() => {}), this.leaderboardMs));
    const first = setTimeout(() => this.refreshAll().catch(() => {}), 3000);
    first.unref?.();
    this.timers.push(first);
  }

  stop() {
    for (const t of this.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    this.timers = [];
  }

  async refreshAll(which = null) {
    this.tick++;
    for (const cfg of this.guildRepo.getAllGuildConfigs()) {
      if ((!which || which === "status") && cfg.statusChannelId) {
        await this.refreshPanel(cfg, "status").catch((e) => this.logger.warn(`[panels] status refresh failed (${cfg.guildId}): ${e.message}`));
      }
      if ((!which || which === "leaderboard") && cfg.leaderboardChannelId) {
        await this.refreshPanel(cfg, "leaderboard").catch((e) => this.logger.warn(`[panels] leaderboard refresh failed (${cfg.guildId}): ${e.message}`));
      }
    }
  }

  async buildPayload(kind) {
    if (kind === "status") {
      const active = new Set((this.wsServer?.getActiveSessions() || []).map((s) => s.serverId));
      const embeds = buildStatusEmbeds(this.snapshotRepo.getAllSnapshots(), active, { page: this.tick });
      return { content: "", embeds: embeds.map((e) => e.toJSON()) };
    }
    const boards = await this.statsService.getLeaderboards(10);
    return { content: "", embeds: [buildLeaderboardEmbed(boards, { iconURL: this.client.user?.displayAvatarURL?.() }).toJSON()] };
  }

  /** Serialises refreshes per guild+panel so a timer tick and `/setup panels` can never both post a new message. */
  refreshPanel(cfg, kind) {
    const key = `${cfg.guildId}:${kind}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this._refreshPanel(cfg, kind).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /** Edits the stored message, or creates it (and stores its id) when missing/deleted. */
  async _refreshPanel(cfg, kind) {
    const channelId = kind === "status" ? cfg.statusChannelId : cfg.leaderboardChannelId;
    const messageId = kind === "status" ? cfg.statusMessageId : cfg.leaderboardMessageId;
    const idField = kind === "status" ? "statusMessageId" : "leaderboardMessageId";

    const payload = await this.buildPayload(kind);
    // The embed timestamp changes every build; hash without it so identical data is not re-sent
    const hash = JSON.stringify(payload, (k, v) => (k === "timestamp" ? undefined : v));
    const key = `${cfg.guildId}:${kind}`;
    if (messageId && this.lastHash.get(key) === hash) return false;

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;

    let message = null;
    if (messageId) message = await channel.messages.fetch(messageId).catch(() => null);

    if (message) {
      await message.edit(payload);
    } else {
      message = await channel.send(payload);
      this.guildRepo.upsertGuildConfig(cfg.guildId, { [idField]: message.id });
      cfg[idField] = message.id;
    }
    this.lastHash.set(key, hash);
    return true;
  }
}

module.exports = { LivePanels };
