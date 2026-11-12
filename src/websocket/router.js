const { createAck } = require("./protocol");

const STEAM_ID = /^\d{17}$/;
const MAX_SESSION_BACKLOG = 1000;
// Events that overwrite state and are safe to replay; they skip the dedupe table (saves a write per snapshot).
const IDEMPOTENT_EVENTS = new Set(["server.snapshot"]);

const clampText = (v, max = 64) => (typeof v === "string" ? v.slice(0, max) : v == null ? v : String(v).slice(0, max));
const validSteam = (v) => typeof v === "string" && STEAM_ID.test(v);

/** Drops malformed Steam IDs and bounds free-text fields so a faulty or hostile game server cannot pollute the DB. */
function normalizePayload(type, p) {
  const out = { ...p };
  for (const k of ["steamId", "killerSteamId", "victimSteamId"]) {
    if (out[k] != null && !validSteam(String(out[k]))) out[k] = null;
    else if (out[k] != null) out[k] = String(out[k]);
  }
  for (const k of ["playerName", "killerName", "victimName"]) if (k in out) out[k] = clampText(out[k], 64);
  if ("durationSeconds" in out) out.durationSeconds = Math.min(Math.max(0, Math.trunc(Number(out.durationSeconds)) || 0), 30 * 86400);
  if ("ttlSeconds" in out) out.ttlSeconds = Math.min(Math.max(30, Math.trunc(Number(out.ttlSeconds)) || 600), 900);
  if ("code" in out) out.code = clampText(String(out.code ?? ""), 16);
  return out;
}

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

  /**
   * Queues the envelope behind earlier ones from the same session, so events are applied in the order the game sent
   * them (chat order, join-before-leave) even though handling awaits Discord I/O. The backlog is bounded; when it is
   * full the event is left un-acked and the plugin's durable outbox retransmits it later.
   */
  handleEnvelope(session, envelope) {
    if (!envelope || envelope.kind !== "event") return Promise.resolve();
    session._routerBacklog = (session._routerBacklog || 0) + 1;
    if (session._routerBacklog > MAX_SESSION_BACKLOG) {
      session._routerBacklog--;
      return Promise.resolve();
    }
    const run = () => this._handle(session, envelope).finally(() => { session._routerBacklog--; });
    const next = (session._routerChain || Promise.resolve()).then(run, run);
    session._routerChain = next.catch(() => {});
    return next;
  }

  async _handle(session, envelope) {
    // The authenticated session is the only source of truth for who sent this; envelope.serverId is untrusted input.
    const serverId = session.serverId;
    const { id, type } = envelope;
    const payload = normalizePayload(type, envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {});
    const idempotent = IDEMPOTENT_EVENTS.has(type);

    try {
      // Claim-first dedupe: the INSERT is the atomic check, so a retransmit that arrives while Discord I/O is still
      // pending is refused instead of being processed (and counted) twice.
      if (!idempotent && !this.dedupeRepo.markEventProcessed(serverId, id, type)) {
        session.send(createAck(envelope, "duplicate"));
        return;
      }
      try {
        await this.processEvent(session, serverId, type, payload);
      } catch (err) {
        if (!idempotent) this.dedupeRepo.releaseEvent(serverId, id); // allow a retry
        throw err;
      }
      session.send(createAck(envelope, "persisted"));
    } catch (err) {
      console.error(`[router] Error processing event ${type} from ${serverId}: ${err.message}`);
      session.send(createAck(envelope, "error"));
    }
  }

  async processEvent(session, serverId, type, payload) {
    switch (type) {
      case "server.snapshot":
        if (!payload.serverName && !this._warnedEmptySnapshot) {
          this._warnedEmptySnapshot = true;
          console.warn(`[router] server.snapshot from ${serverId} has no serverName; payload keys: ${Object.keys(payload).join(",") || "(none)"}`);
        }
        this.snapshotRepo.saveSnapshot(serverId, payload);
        this.discordLogger?.rememberGroups?.(payload.players);
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
            group: payload.group || payload.Group,
          });
        }
        break;

      case "player.disconnected":
        // Playtime is accounted exclusively from `player.session.ended` (clock-skew protected) to avoid double counting.
        if (this.discordLogger) {
          await this.discordLogger.logPlayerDisconnected({
            serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            durationSeconds: payload.durationSeconds ?? payload.sessionLengthSeconds,
            group: payload.group || payload.Group,
          });
        }
        break;

      case "player.session.ended":
        if (payload.steamId) {
          this.statsRepo.recordPlaytime(payload.steamId, payload.playerName, payload.durationSeconds);
        }
        break;

      case "player.chat":
        if (this.chatRelay) {
          await this.chatRelay.handleGameChatEvent({
            serverId,
            serverName: payload.serverName || session.serverName || serverId,
            steamId: payload.steamId,
            playerName: payload.playerName,
            message: payload.message || payload.messageText,
            mode: payload.mode || payload.chatMode || payload.channel || "Global",
            locationName: payload.locationName,
            group: payload.group,
          });
        }
        break;

      // The plugin emits BOTH events for a PvP kill: `player.kill` credits the killer only and
      // `player.death` debits the victim only. Each increments exactly one side, so nothing is double counted.
      case "player.kill":
        if (payload.killerSteamId) {
          this.statsRepo.recordKillCredit(payload.killerSteamId, payload.killerName, Boolean(payload.isHeadshot));
        }
        break;

      case "player.death":
        if (payload.victimSteamId) {
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
          await this.discordLogger.logCommand({ ...payload, serverId });
        }
        break;

      case "log.punishment":
        if (this.discordLogger) {
          await this.discordLogger.logPunishment({ ...payload, serverId });
        }
        break;

      default:
        console.warn(`[router] Unrecognized event type: ${type} from ${serverId}`);
        break;
    }
  }
}

module.exports = { MessageRouter };
