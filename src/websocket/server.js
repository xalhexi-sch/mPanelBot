const http = require("node:http");
const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const { WebSocketServer } = require("ws");
const { Session } = require("./session");
const {
  validateEnvelope,
  createWelcome,
  createEnvelope,
} = require("./protocol");

class GameWebSocketServer extends EventEmitter {
  constructor({
    apiKey,
    heartbeatIntervalMs = 30000,
    maxPayloadSizeBytes = 262144,
  }) {
    super();
    this.apiKey = String(apiKey || "");
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxPayloadSizeBytes = maxPayloadSizeBytes;

    this.sessions = new Map(); // serverId -> Session
    this.wss = null;
    this.heartbeatTimer = null;
  }

  isAuthorizedHeader(headerValue) {
    if (!headerValue || !this.apiKey) return false;

    let providedKey = "";
    if (headerValue.startsWith("Bearer ")) {
      providedKey = headerValue.slice(7).trim();
    } else {
      providedKey = headerValue.trim();
    }

    if (!providedKey) return false;

    const keyBuf = Buffer.from(this.apiKey, "utf8");
    const provBuf = Buffer.from(providedKey, "utf8");

    if (keyBuf.length !== provBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(keyBuf, provBuf);
  }

  handleUpgrade(req, socket, head) {
    const authHeader = req.headers["authorization"] || req.headers["x-api-key"];

    if (!this.isAuthorizedHeader(authHeader)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      this.emit("auth_failed", {
        remoteAddress: socket.remoteAddress,
        url: req.url,
      });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.maxPayloadSizeBytes,
    });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/ws" || url.pathname === "/") {
        this.handleUpgrade(req, socket, head);
      } else {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.startHeartbeatLoop();
  }

  handleConnection(ws, req) {
    const remoteAddress = req.socket.remoteAddress;
    let establishedSession = null;

    // Must receive a valid 'hello' within 10 seconds
    const helloTimeout = setTimeout(() => {
      if (!establishedSession) {
        try {
          ws.close(4001, "Handshake timeout: expected hello message");
        } catch {}
      }
    }, 10000);

    ws.on("message", (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch (err) {
        try {
          ws.send(JSON.stringify(createEnvelope({
            kind: "error",
            type: "system.error",
            serverId: establishedSession?.serverId || "unknown",
            payload: { error: "Invalid JSON message" },
          })));
        } catch {}
        return;
      }

      const val = validateEnvelope(parsed, this.maxPayloadSizeBytes);
      if (!val.valid) {
        try {
          ws.send(JSON.stringify(createEnvelope({
            kind: "error",
            type: "system.error",
            serverId: establishedSession?.serverId || "unknown",
            payload: { error: val.error },
          })));
        } catch {}
        return;
      }

      // First message must be hello
      if (!establishedSession) {
        if (parsed.kind !== "hello") {
          ws.close(4002, "First message must be hello");
          return;
        }

        clearTimeout(helloTimeout);
        const serverId = parsed.serverId.trim();
        const payload = parsed.payload || {};

        // Replace any existing session with this serverId
        const existing = this.sessions.get(serverId);
        if (existing) {
          existing.close(4000, "Replaced by new connection");
          this.sessions.delete(serverId);
        }

        establishedSession = new Session({
          ws,
          serverId,
          remoteAddress,
          pluginVersion: payload.pluginVersion || "1.0.0",
          serverName: payload.serverName || serverId,
        });

        this.sessions.set(serverId, establishedSession);

        establishedSession.on("close", () => {
          if (this.sessions.get(serverId) === establishedSession) {
            this.sessions.delete(serverId);
          }
          this.emit("server_disconnected", serverId);
        });

        establishedSession.on("error", (err) => {
          this.emit("session_error", { serverId, error: err });
        });

        // Send welcome back
        const welcome = createWelcome(serverId, this.heartbeatIntervalMs);
        establishedSession.send(welcome);

        this.emit("server_connected", establishedSession);
        return;
      }

      // Heartbeat message handling
      if (parsed.kind === "heartbeat") {
        establishedSession.lastHeartbeatAt = new Date();
        establishedSession.send(createEnvelope({
          kind: "heartbeat",
          type: "system.heartbeat",
          serverId: establishedSession.serverId,
          payload: { timestampUtc: new Date().toISOString() },
        }));
        return;
      }

      // Handle command results
      if (parsed.kind === "command.result") {
        const handled = establishedSession.handleCommandResult(parsed);
        if (handled) return;
      }

      // Emit all other valid envelopes for routing
      this.emit("envelope", establishedSession, parsed);
    });
  }

  startHeartbeatLoop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      for (const [serverId, session] of this.sessions.entries()) {
        if (!session.isAlive) {
          session.close(4003, "Heartbeat timeout");
          this.sessions.delete(serverId);
          continue;
        }

        session.isAlive = false;
        try {
          session.ws.ping();
        } catch {
          session.close(4004, "Ping error");
          this.sessions.delete(serverId);
        }
      }
    }, this.heartbeatIntervalMs);
  }

  getSession(serverId) {
    return this.sessions.get(String(serverId || "").trim()) || null;
  }

  getActiveSessions() {
    return Array.from(this.sessions.values());
  }

  broadcast(envelope) {
    for (const session of this.sessions.values()) {
      session.send(envelope);
    }
  }

  close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const session of this.sessions.values()) {
      session.close(1001, "Server shutting down");
    }
    this.sessions.clear();

    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = { GameWebSocketServer };
