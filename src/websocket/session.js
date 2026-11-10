const EventEmitter = require("node:events");
const { createEnvelope } = require("./protocol");

const MAX_OUTBOUND_QUEUE_SIZE = 500;
// If the socket itself is buffering this much unsent data the peer is not reading; drop it instead of growing memory.
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;

class Session extends EventEmitter {
  constructor({ ws, serverId, remoteAddress, pluginVersion = "unknown", serverName = "unknown" }) {
    super();
    this.ws = ws;
    this.serverId = serverId;
    this.remoteAddress = remoteAddress;
    this.pluginVersion = pluginVersion;
    this.serverName = serverName;
    this.connectedAt = new Date();
    this.lastHeartbeatAt = new Date();
    this.isAlive = true;

    this.pendingCommands = new Map(); // correlationId -> { resolve, reject, timer }
    this.outboundQueue = [];
    this.isFlushing = false;
    this.isClosed = false;

    this.setupSocket();
  }

  setupSocket() {
    this.ws.on("pong", () => {
      this.isAlive = true;
      this.lastHeartbeatAt = new Date();
    });

    this.ws.on("close", (code, reason) => {
      this.handleClose(code, reason);
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
    });
  }

  send(data) {
    if (this.isClosed || this.ws.readyState !== 1) { // 1 = OPEN
      return false;
    }

    const payload = typeof data === "string" ? data : JSON.stringify(data);

    if (this.outboundQueue.length >= MAX_OUTBOUND_QUEUE_SIZE) {
      // Bounded queue: drop oldest non-urgent item if full
      this.outboundQueue.shift();
      this.emit("queue_dropped", { serverId: this.serverId });
    }

    this.outboundQueue.push(payload);
    this.flush();
    return true;
  }

  flush() {
    if (this.isFlushing || this.isClosed || this.ws.readyState !== 1) return;
    this.isFlushing = true;

    while (this.outboundQueue.length > 0) {
      if (this.ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
        this.isFlushing = false;
        this.emit("queue_dropped", { serverId: this.serverId, slowConsumer: true });
        this.close(1013, "Slow consumer");
        return;
      }
      const msg = this.outboundQueue.shift();
      try {
        this.ws.send(msg);
      } catch (err) {
        this.emit("error", err);
        break;
      }
    }

    this.isFlushing = false;
  }

  sendCommand(commandEnvelope, timeoutMs = 15000) {
    if (this.isClosed || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`Server ${this.serverId} is not connected.`));
    }

    const correlationId = commandEnvelope.correlationId;
    if (!correlationId) {
      return Promise.reject(new Error("Command envelope missing correlationId."));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(correlationId);
        reject(new Error(`Command timed out after ${timeoutMs}ms waiting for server response.`));
      }, timeoutMs);

      this.pendingCommands.set(correlationId, { resolve, reject, timer });

      const sent = this.send(commandEnvelope);
      if (!sent) {
        clearTimeout(timer);
        this.pendingCommands.delete(correlationId);
        reject(new Error(`Failed to send command to server ${this.serverId}.`));
      }
    });
  }

  handleCommandResult(resultEnvelope) {
    const correlationId = resultEnvelope.correlationId;
    if (!correlationId || !this.pendingCommands.has(correlationId)) {
      return false;
    }

    const { resolve, timer } = this.pendingCommands.get(correlationId);
    clearTimeout(timer);
    this.pendingCommands.delete(correlationId);

    resolve(resultEnvelope);
    return true;
  }

  handleClose(code, reason) {
    if (this.isClosed) return;
    this.isClosed = true;

    // Reject all pending commands
    for (const [corrId, { reject, timer }] of this.pendingCommands.entries()) {
      clearTimeout(timer);
      reject(new Error(`Connection to server ${this.serverId} closed before command completed.`));
    }
    this.pendingCommands.clear();
    this.outboundQueue.length = 0;

    this.emit("close", code, reason);
  }

  close(code = 1000, reason = "Normal closure") {
    if (this.isClosed) return;
    try {
      this.ws.close(code, reason);
    } catch {}
    this.handleClose(code, reason);
  }
}

module.exports = { Session, MAX_OUTBOUND_QUEUE_SIZE, MAX_SOCKET_BUFFER_BYTES };
