const http = require("node:http");

/**
 * Minimal HTTP surface that shares the WebSocket port.
 *  - `GET /health`: public liveness probe, reveals nothing but `{ "status": "ok" }`.
 *  - `GET /health` with a valid `Authorization: Bearer <key>`: adds uptime and connected servers (operators only).
 */
function createHealthServer({ wsServer }) {
  const server = http.createServer((req, res) => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    let pathname = "/";
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {}

    if (req.method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
      const body = { status: "ok" };
      // Bearer guesses here share the failed-auth throttle with the WebSocket upgrade.
      const address = wsServer?.clientAddress?.(req) || req.socket.remoteAddress;
      const throttled = wsServer && !wsServer.isThrottleExempt?.(address);
      if (throttled && wsServer.authThrottle.blockedFor(address) > 0) {
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "Too Many Requests" }));
        return;
      }
      const presented = Boolean(req.headers["authorization"]);
      const authed = wsServer?.authenticate?.(req.headers["authorization"]);
      if (throttled && presented && !authed?.ok) wsServer.authThrottle.recordFailure(address);

      if (authed?.ok && !authed.keyServerId) {
        body.uptimeSeconds = Math.floor(process.uptime());
        body.connectedServers = wsServer.getActiveSessions().map((s) => ({
          serverId: s.serverId,
          serverName: s.serverName,
          pluginVersion: s.pluginVersion,
          connectedAt: s.connectedAt,
        }));
        body.timestampUtc = new Date().toISOString();
      }

      res.writeHead(200, headers);
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  // Slowloris / idle-socket protection for the plain HTTP side
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  if (wsServer) wsServer.attach(server);
  return server;
}

module.exports = { createHealthServer };
