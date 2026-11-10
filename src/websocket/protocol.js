const crypto = require("node:crypto");

const PROTOCOL_VERSION = 1;

const VALID_KINDS = new Set([
  "hello",
  "welcome",
  "heartbeat",
  "event",
  "ack",
  "command",
  "command.result",
  "error",
]);

function createEnvelope({
  kind,
  type,
  serverId,
  payload = {},
  correlationId = null,
  id = crypto.randomUUID(),
  occurredAtUtc = new Date().toISOString(),
}) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid message kind: ${kind}`);
  }

  const envelope = {
    v: PROTOCOL_VERSION,
    id,
    kind,
    type: String(type || "unknown"),
    serverId: String(serverId || "unknown"),
    occurredAtUtc,
    payload: payload && typeof payload === "object" ? payload : {},
  };

  if (correlationId) {
    envelope.correlationId = String(correlationId);
  }

  return envelope;
}

function createWelcome(serverId, heartbeatIntervalMs = 30000) {
  return createEnvelope({
    kind: "welcome",
    type: "system.welcome",
    serverId,
    payload: {
      protocolVersion: PROTOCOL_VERSION,
      heartbeatIntervalMs,
      serverTimeUtc: new Date().toISOString(),
    },
  });
}

function createAck(incomingMessage, status = "persisted") {
  return createEnvelope({
    kind: "ack",
    type: "event.ack",
    serverId: incomingMessage.serverId,
    correlationId: incomingMessage.id,
    payload: {
      eventId: incomingMessage.id,
      eventType: incomingMessage.type,
      status,
    },
  });
}

function createCommand({
  type,
  serverId,
  payload,
  timeoutMs = 15000,
  id = crypto.randomUUID(),
  correlationId = crypto.randomUUID(),
}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeoutMs);

  const envelope = createEnvelope({
    id,
    kind: "command",
    type,
    serverId,
    correlationId,
    occurredAtUtc: now.toISOString(),
    payload,
  });

  envelope.expiresAtUtc = expiresAt.toISOString();
  return envelope;
}

function validateEnvelope(data, maxPayloadSize = 262144) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Envelope must be a JSON object" };
  }

  if (data.v !== PROTOCOL_VERSION) {
    return { valid: false, error: `Unsupported protocol version: ${data.v}` };
  }

  if (!data.id || typeof data.id !== "string") {
    return { valid: false, error: "Missing or invalid message id" };
  }

  if (!data.kind || !VALID_KINDS.has(data.kind)) {
    return { valid: false, error: `Invalid message kind: ${data.kind}` };
  }

  if (!data.type || typeof data.type !== "string") {
    return { valid: false, error: "Missing or invalid message type" };
  }

  if (!data.serverId || typeof data.serverId !== "string") {
    return { valid: false, error: "Missing or invalid serverId" };
  }

  if (!data.occurredAtUtc || typeof data.occurredAtUtc !== "string") {
    return { valid: false, error: "Missing or invalid occurredAtUtc" };
  }

  return { valid: true };
}

module.exports = {
  PROTOCOL_VERSION,
  VALID_KINDS,
  createEnvelope,
  createWelcome,
  createAck,
  createCommand,
  validateEnvelope,
};
