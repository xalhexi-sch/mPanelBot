const { createAck } = require("./protocol");

class MessageRouter {
  constructor({
    dedupeRepo,
    snapshotRepo,
    statsRepo,
    linkService,
    discordLogger,
    raidNotifier,
    chatRelay,
    discordClient,
  }) {
    this.dedupeRepo = dedupeRepo;
    this.snapshotRepo = snapshotRepo;
    this.statsRepo = statsRepo;
    this.linkService = linkService;
    this.discordLogger = discordLogger;
    this.raidNotifier = raidNotifier;
    this.chatRelay = chatRelay;
    this.discordClient = discordClient;
  }

  async handleEnvelope(session, envelope) {
    if (!envelope || envelope.kind !== "event") {
      return;
    }

    const { serverId, id, type, payload } = envelope;

    // 1. Deduplication check (serverId, id)
    if (this.dedupeRepo.isEventProcessed(serverId, id)) {
      // Idempotent: already handled, reply with ACK immediately
      session.send(createAck(envelope, "duplicate"));
      return;
    }

    // 2. Dispatch by event type
    try {
      await this.processEvent(serverId, type, payload || {});
      // Persist in deduplication store
      this.dedupeRepo.markEventProcessed(serverId, id, type);
      // Send positive ACK
      session.send(createAck(envelope, "persisted"));
    } catch (err) {
      console.error(`[router] Error processing event ${type} from ${serverId}:`, err);
      // Still send ACK with failed status so sender knows it was received
      session.send(createAck(envelope, "error"));
    }
  }

  async processEvent(serverId, type, payload) {
    switch (type) {
      case "server.snapshot":
        this.snapshotRepo.saveSnapshot(serverId, payload);
        if (this.discordClient) {
          this.discordClient.updatePresence();
        }
        break;

      case "player.connected":
        if (payload.steamId) {
          this.statsRepo.updatePlayerSeen(payload.steamId, payload.playerName);
        }
        if (this.discordLogger) {
          await this.discordLogger.logPlayerConnected({
            serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            ping: payload.ping,
          });
        }
        break;

      case "player.disconnected":
        if (payload.steamId && payload.durationSeconds) {
          this.statsRepo.recordPlaytime(payload.steamId, payload.playerName, payload.durationSeconds);
        }
        if (this.discordLogger) {
          await this.discordLogger.logPlayerDisconnected({
            serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            durationSeconds: payload.durationSeconds,
          });
        }
        break;

      case "player.chat":
        if (this.chatRelay) {
          await this.chatRelay.handleGameChatEvent({
            serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            message: payload.message,
            mode: payload.mode || "Global",
          });
        }
        break;

      case "player.kill":
      case "player.death":
        if (payload.killerSteamId) {
          this.statsRepo.recordKill(
            payload.killerSteamId,
            payload.killerName,
            payload.victimSteamId,
            payload.victimName,
            Boolean(payload.isHeadshot)
          );
        } else if (payload.victimSteamId) {
          this.statsRepo.recordDeath(payload.victimSteamId, payload.victimName);
        }
        break;

      case "player.link.requested":
        if (this.linkService) {
          this.linkService.handleLinkRequestedEvent({
            serverId,
            code: payload.code,
            steamId: payload.steamId,
            playerName: payload.playerName,
            ttlSeconds: payload.ttlSeconds || 600,
          });
        }
        break;

      case "player.unlinked":
        if (this.linkService && payload.steamId) {
          this.linkService.unlink({ steamId: payload.steamId });
        }
        break;

      case "raid.alert":
        if (this.raidNotifier) {
          await this.raidNotifier.handleRaidAlert({
            serverId,
            ...payload,
          });
        }
        break;

      case "log.command":
        if (this.discordLogger) {
          await this.discordLogger.logCommand({
            serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            command: payload.command,
          });
        }
        break;

      case "log.punishment":
        if (this.discordLogger) {
          await this.discordLogger.logPunishment({
            serverId,
            adminSteamId: payload.adminSteamId,
            adminName: payload.adminName,
            action: payload.action,
            targetSteamId: payload.targetSteamId,
            targetName: payload.targetName,
            reason: payload.reason,
            duration: payload.duration,
          });
        }
        break;

      default:
        console.warn(`[router] Unrecognized event type: ${type} from ${serverId}`);
        break;
    }
  }
}

module.exports = { MessageRouter };
