const crypto = require("node:crypto");
const { createCommand } = require("../websocket/protocol");
const { buildModerationCommand, validateConsoleCommand } = require("./commandPolicy");

class ModerationService {
  constructor({ wsServer, pterodactylClient, auditRepo, listKnownServerIds = null, pterodactylServerId = null }) {
    this.listKnownServerIds = listKnownServerIds;
    this.pterodactylServerId = pterodactylServerId;
    this.wsServer = wsServer;
    this.pterodactylClient = pterodactylClient;
    this.auditRepo = auditRepo;
  }

  async executeModeration({
    action,
    steam64,
    reason,
    duration,
    serverId = null,
    requestedByDiscordId,
    requestedByTag = null,
  }) {
    const modCmd = buildModerationCommand(action, steam64, reason, duration);
    return this.dispatchServerCommand({
      commandName: modCmd.action,
      fullCommand: modCmd.fullCommand,
      targetSteamId: modCmd.targetSteamId,
      args: [modCmd.targetSteamId, ...(modCmd.durationMinutes ? [String(modCmd.durationMinutes)] : []), modCmd.reason],
      wsPayload: {
        command: modCmd.action,
        args: {
          targetSteamId: modCmd.targetSteamId,
          reason: modCmd.reason,
          ...(modCmd.durationMinutes ? { duration: String(modCmd.durationMinutes) } : {}),
        },
      },
      serverId,
      requestedByDiscordId,
      requestedByTag,
    });
  }

  async executeConsoleCommand({
    rawCommand,
    serverId = null,
    requestedByDiscordId,
    requestedByTag = null,
    allowCustomPolicy = false,
  }) {
    const check = validateConsoleCommand(rawCommand, allowCustomPolicy);
    if (!check.allowed) {
      throw new Error(check.error);
    }

    return this.dispatchServerCommand({
      commandName: check.baseCommand,
      fullCommand: check.sanitizedCommand,
      targetSteamId: null,
      args: check.args,
      wsPayload: { command: "console", args: { command: check.sanitizedCommand } },
      serverId,
      requestedByDiscordId,
      requestedByTag,
    });
  }

  async dispatchServerCommand({
    commandName,
    fullCommand,
    targetSteamId = null,
    args = [],
    wsPayload = null,
    serverId = null,
    requestedByDiscordId,
    requestedByTag = null,
  }) {
    const correlationId = crypto.randomUUID();

    // Never guess the target: with several servers in the network a command without a server could land on the
    // wrong one (e.g. `shutdown`). The target is implicit only when exactly one server exists.
    if (!serverId) {
      const known = new Set([
        ...this.wsServer.getActiveSessions().map((s) => s.serverId),
        ...(this.listKnownServerIds ? this.listKnownServerIds() : []),
      ]);
      if (known.size > 1) {
        throw new Error(`Several servers are known (${[...known].slice(0, 10).join(", ")}). Specify which one with the \`server\` option.`);
      }
    }

    // 1. Try WebSocket connection
    let session = null;
    if (serverId) {
      session = this.wsServer.getSession(serverId);
    } else {
      const active = this.wsServer.getActiveSessions();
      if (active.length > 0) session = active[0];
    }

    if (session && !session.isClosed) {
      const commandEnvelope = createCommand({
        type: "server.command.request",
        serverId: session.serverId,
        correlationId,
        // Typed payload understood by the plugin's moderation module; falls back to the raw command shape.
        payload: {
          ...(wsPayload || { command: fullCommand, args: { command: fullCommand } }),
          requestedBy: requestedByDiscordId,
        },
        timeoutMs: 15000,
      });

      // The plugin enforces expiry from the payload, so mirror the envelope-level value there.
      commandEnvelope.payload.expiresAtUtc = commandEnvelope.expiresAtUtc;

      try {
        const resultEnvelope = await session.sendCommand(commandEnvelope, 15000);
        const success = Boolean(resultEnvelope?.payload?.success);
        const resultMessage = resultEnvelope?.payload?.message || (success ? "Command executed successfully" : "Command failed");

        this.auditRepo.recordAudit({
          id: correlationId,
          serverId: session.serverId,
          commandName,
          fullCommand,
          targetSteamId,
          requestedByDiscordId,
          requestedByTag,
          executedVia: "websocket",
          success,
          resultMessage,
        });

        return {
          success,
          message: resultMessage,
          executedVia: "websocket",
          serverId: session.serverId,
          fullCommand,
        };
      } catch (err) {
        this.auditRepo.recordAudit({
          id: correlationId,
          serverId: session.serverId,
          commandName,
          fullCommand,
          targetSteamId,
          requestedByDiscordId,
          requestedByTag,
          executedVia: "websocket",
          success: false,
          resultMessage: `Error: ${err.message}`,
        });
        throw err;
      }
    }

    // 2. Fallback to Pterodactyl if enabled and configured. The panel client is bound to ONE game server, so it may
    // only stand in for that server; otherwise a command meant for an offline server would run on a different one.
    const pteroTargetOk =
      !serverId ||
      (this.pterodactylServerId
        ? serverId === this.pterodactylServerId
        : !this.listKnownServerIds || this.listKnownServerIds().filter((id) => id !== serverId).length === 0);
    if (this.pterodactylClient && this.pterodactylClient.isConfigured() && pteroTargetOk) {
      try {
        const pteroRes = await this.pterodactylClient.sendCommand(fullCommand);
        this.auditRepo.recordAudit({
          id: correlationId,
          serverId: serverId || "pterodactyl",
          commandName,
          fullCommand,
          targetSteamId,
          requestedByDiscordId,
          requestedByTag,
          executedVia: "pterodactyl",
          success: true,
          resultMessage: "Command sent via Pterodactyl Client API",
        });

        return {
          success: true,
          message: "Command executed via Pterodactyl panel.",
          executedVia: "pterodactyl",
          serverId: serverId || "pterodactyl",
          fullCommand,
        };
      } catch (pteroErr) {
        this.auditRepo.recordAudit({
          id: correlationId,
          serverId: serverId || "pterodactyl",
          commandName,
          fullCommand,
          targetSteamId,
          requestedByDiscordId,
          requestedByTag,
          executedVia: "pterodactyl",
          success: false,
          resultMessage: `Pterodactyl error: ${pteroErr.message}`,
        });
        throw pteroErr;
      }
    }

    throw new Error(
      serverId
        ? `Server '${serverId}' is not currently connected via WebSocket and Pterodactyl fallback is unavailable.`
        : "No Unturned servers are currently connected via WebSocket."
    );
  }
}

module.exports = { ModerationService };
