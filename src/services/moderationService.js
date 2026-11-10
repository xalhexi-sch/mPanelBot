const crypto = require("node:crypto");
const { createCommand } = require("../websocket/protocol");
const { buildModerationCommand, validateConsoleCommand } = require("./commandPolicy");

class ModerationService {
  constructor({ wsServer, pterodactylClient, auditRepo }) {
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
    serverId = null,
    requestedByDiscordId,
    requestedByTag = null,
  }) {
    const correlationId = crypto.randomUUID();

    // 1. Try WebSocket connection
    let session = null;
    if (serverId) {
      session = this.wsServer.getSession(serverId);
    } else {
      // Pick first active session if none specified
      const active = this.wsServer.getActiveSessions();
      if (active.length > 0) {
        session = active[0];
      }
    }

    if (session && !session.isClosed) {
      const commandEnvelope = createCommand({
        type: "server.command.request",
        serverId: session.serverId,
        correlationId,
        payload: {
          command: fullCommand,
          commandName,
          targetSteamId,
          args,
          requestedByDiscordId,
        },
        timeoutMs: 15000,
      });

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

    // 2. Fallback to Pterodactyl if enabled and configured
    if (this.pterodactylClient && this.pterodactylClient.isConfigured()) {
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
