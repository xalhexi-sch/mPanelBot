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
const { AuthThrottle, TokenBucket } = require("./threatGuard");

const LOOPBACK = /^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/;

const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Constant-time comparison that does not leak the secret's length (both sides are hashed first). */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class GameWebSocketServer extends EventEmitter {
  constructor({
    apiKey,
    heartbeatIntervalMs = 30000,
    maxPayloadSizeBytes = 262144,
    serverKeys = {},
    messageRatePerSec = 40,
    messageBurst = 200,
    authThrottle = new AuthThrottle(),
    trustProxy = false,
  }) {
    super();
    // Only when a TLS-terminating reverse proxy on this machine fronts the port: use the address it appends to
    // X-Forwarded-For. Otherwise every game server would share the proxy's address and one bad client could lock all out.
    this.trustProxy = Boolean(trustProxy);
    this.apiKey = String(apiKey || "");
    // Optional dedicated key per ServerId. When a server has one, the shared key can no longer impersonate it.
    this.serverKeys = new Map(Object.entries(serverKeys || {}).filter(([id, k]) => SERVER_ID_PATTERN.test(id) && k));
    this.messageRatePerSec = messageRatePerSec;
    this.messageBurst = messageBurst;
    this.authThrottle = authThrottle;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.maxPayloadSizeBytes = maxPayloadSizeBytes;

    this.sessions = new Map(); // serverId -> Session
    this.wss = null;
    this.heartbeatTimer = null;
  }

  /**
   * @returns {{ok:boolean, keyServerId:string|null}} keyServerId is set when a per-server key matched.
   * Every candidate is compared (no early exit) so timing does not reveal which key was close.
   */
  authenticate(headerValue) {
    if (!headerValue || typeof headerValue !== "string") return { ok: false, keyServerId: null };
    const provided = (headerValue.startsWith("Bearer ") ? headerValue.slice(7) : headerValue).trim();
    if (!provided) return { ok: false, keyServerId: null };

    let result = { ok: false, keyServerId: null };
    if (this.apiKey && safeEqual(provided, this.apiKey)) result = { ok: true, keyServerId: null };
    for (const [serverId, key] of this.serverKeys) {
      if (safeEqual(provided, key) && !result.ok) result = { ok: true, keyServerId: serverId };
    }
    return result;
  }

  /** Peer address used for throttling (the real client when a trusted local proxy supplies it). */
  clientAddress(req) {
    const peer = req.socket?.remoteAddress || "unknown";
    if (this.trustProxy && LOOPBACK.test(peer)) {
      const xff = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length > 0) return xff[xff.length - 1];
    }
    return peer;
  }

  /** Fail-safe default: everything is throttled. Enable `trustProxy` when behind a local reverse proxy. */
  isThrottleExempt() {
    return false;
  }

  isAuthorizedHeader(headerValue) {
    return this.authenticate(headerValue).ok;
  }

  handleUpgrade(req, socket, head) {
    // Without a listener, a connection reset during/after the upgrade is an uncaught 'error' that kills the process.
    socket.on("error", () => {});
    const address = this.clientAddress(req);
    const throttled = !this.isThrottleExempt(address);

    const blockedMs = throttled ? this.authThrottle.blockedFor(address) : 0;
    if (blockedMs > 0) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: " + Math.ceil(blockedMs / 1000) + "\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const auth = this.authenticate(req.headers["authorization"] || req.headers["x-api-key"]);

    if (!auth.ok) {
      const nowBlocked = throttled ? this.authThrottle.recordFailure(address) : false;
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      this.emit("auth_failed", { remoteAddress: address, url: req.url, blocked: nowBlocked });
      return;
    }

    this.authThrottle.recordSuccess(address);
    req.clientAddress = address;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      req.keyServerId = auth.keyServerId;
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
    const remoteAddress = req.clientAddress || req.socket.remoteAddress;
    let establishedSession = null;
    const bucket = new TokenBucket({ ratePerSec: this.messageRatePerSec, burst: this.messageBurst });

    // Must receive a valid 'hello' within 10 seconds
    const helloTimeout = setTimeout(() => {
      if (!establishedSession) {
        try {
          ws.close(4001, "Handshake timeout: expected hello message");
        } catch {}
      }
    }, 10000);

    // Pre-hello there is no Session yet to own socket errors (oversized frame, protocol violation...).
    // An 'error' event with no listener would crash the whole bot.
    ws.on("error", () => {});
    ws.on("close", () => clearTimeout(helloTimeout));

    ws.on("message", (raw) => {
      if (!bucket.take()) {
        this.emit("rate_limited", { remoteAddress, serverId: establishedSession?.serverId || null });
        try {
          ws.close(4008, "Rate limit exceeded");
        } catch {}
        return;
      }

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
        parsed.serverId = serverId;
        const payload = parsed.payload || {};

        // Identity rules: well-formed id, and a per-server key may only speak for its own server.
        const dedicated = this.serverKeys.get(serverId);
        const keyBelongsElsewhere = req.keyServerId && req.keyServerId !== serverId;
        const sharedKeyOnProtectedServer = dedicated && !req.keyServerId;
        if (!SERVER_ID_PATTERN.test(serverId) || keyBelongsElsewhere || sharedKeyOnProtectedServer) {
          if (!this.isThrottleExempt(remoteAddress)) this.authThrottle.recordFailure(remoteAddress);
          this.emit("auth_failed", { remoteAddress, url: "hello", blocked: false });
          ws.close(4005, "Not authorised for this server id");
          return;
        }

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

      // An authenticated connection may only speak for its own server id.
      if (parsed.serverId !== establishedSession.serverId) {
        this.emit("identity_mismatch", { serverId: establishedSession.serverId, claimed: String(parsed.serverId).slice(0, 64) });
        establishedSession.close(4005, "serverId does not match the authenticated session");
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
