const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const WebSocket = require("ws");

const { AuthThrottle, TokenBucket } = require("../src/websocket/threatGuard");
const { GameWebSocketServer } = require("../src/websocket/server");
const { createHealthServer } = require("../src/http/healthServer");
const { loadConfig } = require("../src/config");

const SHARED = "shared-key-0123456789abcdef0123456789";
const DEDICATED = "dedicated-key-for-server-a-0123456789";

describe("AuthThrottle / TokenBucket", () => {
  it("blocks an address after repeated failures and releases it after the block expires", () => {
    let t = 1_000;
    const th = new AuthThrottle({ maxFailures: 3, windowMs: 60_000, blockMs: 10_000, now: () => t });
    assert.strictEqual(th.blockedFor("1.2.3.4"), 0);
    th.recordFailure("1.2.3.4");
    th.recordFailure("1.2.3.4");
    assert.strictEqual(th.blockedFor("1.2.3.4"), 0, "not yet");
    assert.strictEqual(th.recordFailure("1.2.3.4"), true);
    assert.ok(th.blockedFor("1.2.3.4") > 0);
    assert.strictEqual(th.blockedFor("5.6.7.8"), 0, "other addresses unaffected");
    t += 10_001;
    assert.strictEqual(th.blockedFor("1.2.3.4"), 0);
  });

  it("forgets old failures outside the window and clears on success", () => {
    let t = 0;
    const th = new AuthThrottle({ maxFailures: 2, windowMs: 1000, blockMs: 5000, now: () => t });
    th.recordFailure("a");
    t += 2000;
    th.recordFailure("a");
    assert.strictEqual(th.blockedFor("a"), 0, "first failure aged out of the window");
    th.recordFailure("a");
    th.recordSuccess("a");
    assert.strictEqual(th.blockedFor("a"), 0);
  });

  it("is memory-bounded", () => {
    const th = new AuthThrottle({ maxEntries: 100 });
    for (let i = 0; i < 1000; i++) th.recordFailure(`10.0.${i >> 8}.${i & 255}`);
    assert.ok(th.entries.size <= 100);
  });

  it("token bucket allows a burst, refuses a flood, then refills", () => {
    let t = 0;
    const b = new TokenBucket({ ratePerSec: 10, burst: 5, now: () => t });
    for (let i = 0; i < 5; i++) assert.strictEqual(b.take(), true);
    assert.strictEqual(b.take(), false);
    t += 1000;
    assert.strictEqual(b.take(), true);
  });
});

describe("WebSocket server hardening", () => {
  let server, httpServer;

  async function start(opts = {}) {
    server = new GameWebSocketServer({ apiKey: SHARED, heartbeatIntervalMs: 60_000, ...opts });
    httpServer = createHealthServer({ wsServer: server });
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    return httpServer.address().port;
  }

  afterEach(async () => {
    server?.close();
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(() => r()));
    }
    server = httpServer = null;
  });

  const connect = (port, key) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${key}` } });
      ws.once("open", () => resolve({ ws, status: 101 }));
      ws.once("unexpected-response", (_q, res) => resolve({ status: res.statusCode }));
      ws.once("error", () => {});
    });

  const hello = (serverId) =>
    JSON.stringify({ v: 1, id: "h" + serverId, kind: "hello", type: "system.hello", serverId, occurredAtUtc: new Date().toISOString(), payload: {} });

  it("answers 429 once an address keeps sending wrong keys, even if a later key is correct", async () => {
    const port = await start({ authThrottle: new AuthThrottle({ maxFailures: 3 }) });
    for (let i = 0; i < 3; i++) assert.strictEqual((await connect(port, "wrong")).status, 401);
    assert.strictEqual((await connect(port, "wrong")).status, 429);
    assert.strictEqual((await connect(port, SHARED)).status, 429, "blocked address stays blocked");
  });

  it("closes a connection that floods messages", async () => {
    const port = await start({ messageRatePerSec: 5, messageBurst: 10 });
    const { ws } = await connect(port, SHARED);
    const closed = new Promise((r) => ws.once("close", (code) => r(code)));
    for (let i = 0; i < 100; i++) ws.send(hello("flood-1"));
    assert.strictEqual(await closed, 4008);
  });

  it("rejects malformed server ids in hello", async () => {
    const port = await start();
    const { ws } = await connect(port, SHARED);
    const closed = new Promise((r) => ws.once("close", (code) => r(code)));
    ws.send(hello("bad id; DROP TABLE"));
    assert.strictEqual(await closed, 4005);
  });

  it("per-server keys: dedicated key works for its server only; shared key cannot impersonate it", async () => {
    const port = await start({ serverKeys: { "server-a": DEDICATED } });

    const own = await connect(port, DEDICATED);
    assert.strictEqual(own.status, 101);
    const welcomed = new Promise((r) => own.ws.on("message", (m) => JSON.parse(m).kind === "welcome" && r(true)));
    own.ws.send(hello("server-a"));
    assert.ok(await welcomed);

    const other = await connect(port, DEDICATED);
    const closedOther = new Promise((r) => other.ws.once("close", (c) => r(c)));
    other.ws.send(hello("server-b"));
    assert.strictEqual(await closedOther, 4005, "a server key cannot speak for another server");

    const shared = await connect(port, SHARED);
    const closedShared = new Promise((r) => shared.ws.once("close", (c) => r(c)));
    shared.ws.send(hello("server-a"));
    assert.strictEqual(await closedShared, 4005, "shared key cannot take over a protected server");

    const free = await connect(port, SHARED);
    const ok = new Promise((r) => free.ws.on("message", (m) => JSON.parse(m).kind === "welcome" && r(true)));
    free.ws.send(hello("server-c"));
    assert.ok(await ok, "shared key still works for unprotected servers");
  });

  it("health: public probe reveals nothing; only the shared key sees connected servers", async () => {
    const port = await start({ serverKeys: { "server-a": DEDICATED } });
    const { ws } = await connect(port, SHARED);
    const welcomed = new Promise((r) => ws.on("message", (m) => JSON.parse(m).kind === "welcome" && r(true)));
    ws.send(hello("server-z"));
    await welcomed;

    const get = (headers = {}) =>
      new Promise((resolve) =>
        http.get({ host: "127.0.0.1", port, path: "/health", headers }, (res) => {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => resolve(JSON.parse(b)));
        })
      );

    assert.deepStrictEqual(await get(), { status: "ok" });
    assert.deepStrictEqual(await get({ Authorization: "Bearer nope" }), { status: "ok" });
    assert.deepStrictEqual(await get({ Authorization: `Bearer ${DEDICATED}` }), { status: "ok" }, "a server key is not an operator key");
    const detail = await get({ Authorization: `Bearer ${SHARED}` });
    assert.strictEqual(detail.connectedServers[0].serverId, "server-z");
  });
});

describe("config", () => {
  it("ignores weak or malformed per-server keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
    const file = path.join(dir, "config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ discord: { token: "t".repeat(30) }, network: { apiKey: "k".repeat(40), serverKeys: { ok: "x".repeat(30), short: "abc", "bad id": "y".repeat(30) } } })
    );
    assert.deepStrictEqual(Object.keys(loadConfig(file).network.serverKeys), ["ok"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
