const http = require("node:http");

function createHealthServer({ wsServer, host = "0.0.0.0", port = 28600 }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
      const activeSessions = wsServer ? wsServer.getActiveSessions() : [];
      const payload = {
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        connectedServers: activeSessions.map((s) => ({
          serverId: s.serverId,
          serverName: s.serverName,
          pluginVersion: s.pluginVersion,
          connectedAt: s.connectedAt,
        })),
        timestampUtc: new Date().toISOString(),
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  if (wsServer) {
    wsServer.attach(server);
  }

  return server;
}

module.exports = { createHealthServer };
