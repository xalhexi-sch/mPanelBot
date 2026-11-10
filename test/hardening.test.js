const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const WebSocket = require("ws");

const { GameWebSocketServer } = require("../src/websocket/server");
const { AuthThrottle } = require("../src/websocket/threatGuard");
const { Session } = require("../src/websocket/session");
const { createHealthServer } = require("../src/http/healthServer");
const { MessageRouter } = require("../src/websocket/router");
const { DatabaseManager } = require("../src/database");
const { DedupeRepository } = require("../src/database/repositories/dedupeRepository");
const { LinkRepository } = require("../src/database/repositories/linkRepository");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { LinkService } = require("../src/services/linkService");
const { ModerationService } = require("../src/services/moderationService");
const { GuildPolicy } = require("../src/discord/guildPolicy");
const { ChatRelay } = require("../src/discord/relay/chatRelay");

const KEY = "hardening-key-0123456789abcdef0123";
const env = (o) => ({
  v: 1,
  id: "e" + Math.random(),
  kind: "event",
  type: "player.chat",
  serverId: "s1",
  occurredAtUtc: new Date().toISOString(),
  payload: {},
  ...o,
});

describe("WebSocket server robustness", () => {
  let server, http;
  afterEach(async () => {
    server?.close();
    http?.closeAllConnections?.();
    if (http) await new Promise((r) => http.close(() => r()));
    server = http = null;
  });
  async function start(opts) {
    server = new GameWebSocketServer({ apiKey: KEY, heartbeatIntervalMs: 60000, ...opts });
    http = createHealthServer({ wsServer: server });
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    return http.address().port;
  }
  const open = (port) =>
    new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${KEY}` } });
      ws.once("open", () => res(ws));
    });

  it("survives an oversized frame before hello (no uncaught 'error')", async () => {
    const port = await start({ maxPayloadSizeBytes: 1024 });
    const ws = await open(port);
    const closed = new Promise((r) => ws.once("close", r));
    ws.send("x".repeat(5000));
    await closed;
    const ws2 = await open(port); // the process is still alive and serving
    ws2.close();
  });

  it("survives a raw TCP reset right after the upgrade request", async () => {
    const port = await start();
    await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
            `Authorization: Bearer ${KEY}\r\n\r\n`
        );
        if (s.resetAndDestroy) s.resetAndDestroy();
        else s.destroy();
        setTimeout(resolve, 100);
      });
      s.on("error", () => {});
    });
    const ws = await open(port);
    ws.close();
  });

  it("closes a session whose later envelopes claim another serverId (identity spoofing)", async () => {
    const port = await start();
    const ws = await open(port);
    const mismatch = new Promise((r) => server.once("identity_mismatch", r));
    const closed = new Promise((r) => ws.once("close", (c) => r(c)));
    ws.send(JSON.stringify({ v: 1, id: "h1", kind: "hello", type: "system.hello", serverId: "real", occurredAtUtc: new Date().toISOString(), payload: {} }));
    await new Promise((r) => ws.once("message", r)); // welcome
    ws.send(JSON.stringify(env({ serverId: "victim" })));
    assert.strictEqual((await mismatch).claimed, "victim");
    assert.strictEqual(await closed, 4005);
  });

  it("throttles /health bearer guessing", async () => {
    const port = await start({ authThrottle: new AuthThrottle({ maxFailures: 3 }) });
    const get = (auth) => fetch(`http://127.0.0.1:${port}/health`, { headers: auth ? { Authorization: auth } : {} }).then((r) => r.status);
    assert.strictEqual(await get(), 200, "anonymous probe is never throttled");
    for (let i = 0; i < 3; i++) await get("Bearer wrong-key");
    assert.strictEqual(await get(`Bearer ${KEY}`), 429);
  });

  it("trustProxy keys the throttle on the forwarded address, not the shared proxy address", async () => {
    const port = await start({ trustProxy: true, authThrottle: new AuthThrottle({ maxFailures: 2 }) });
    const get = (xff, auth) =>
      fetch(`http://127.0.0.1:${port}/health`, { headers: { "X-Forwarded-For": xff, Authorization: auth } }).then((r) => r.status);
    await get("9.9.9.9", "Bearer bad");
    await get("9.9.9.9", "Bearer bad");
    assert.strictEqual(await get("9.9.9.9", `Bearer ${KEY}`), 429, "attacker blocked");
    assert.strictEqual(await get("8.8.8.8", `Bearer ${KEY}`), 200, "another client behind the same proxy unaffected");
  });
});

describe("Session backpressure", () => {
  it("drops a peer that is not reading instead of buffering without bound", () => {
    const sent = [];
    const ws = { readyState: 1, bufferedAmount: 9 * 1024 * 1024, on() {}, send: (m) => sent.push(m), close() {} };
    const s = new Session({ ws, serverId: "s1", remoteAddress: "x" });
    let closed = null;
    s.on("close", (code) => (closed = code));
    s.send({ a: 1 });
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(closed, 1013);
  });
});

describe("MessageRouter", () => {
  let dedupe;
  const mk = (extra = {}) => {
    const db = new DatabaseManager(":memory:");
    dedupe = new DedupeRepository(db);
    return new MessageRouter({ dedupeRepo: dedupe, snapshotRepo: { saveSnapshot() {} }, statsRepo: {}, ...extra });
  };
  const sess = (id = "real") => {
    const out = [];
    return { serverId: id, serverName: "Name", send: (m) => out.push(m), out };
  };

  it("attributes events to the authenticated session, never to envelope.serverId", async () => {
    let seen = null;
    const router = mk({ discordLogger: { logCommand: async (p) => (seen = p) } });
    const s = sess("real");
    await router.handleEnvelope(s, env({ type: "log.command", serverId: "victim", payload: { command: "x" } }));
    assert.strictEqual(seen.serverId, "real");
    assert.ok(dedupe.isEventProcessed("real", s.out[0].payload.eventId));
    assert.ok(!dedupe.isEventProcessed("victim", s.out[0].payload.eventId));
  });

  it("player.chat without serverName no longer throws (session is in scope)", async () => {
    let got = null;
    const router = mk({ chatRelay: { handleGameChatEvent: async (p) => (got = p) } });
    const s = sess("real");
    await router.handleEnvelope(s, env({ payload: { steamId: "76561198000000001", playerName: "P", message: "hi" } }));
    assert.strictEqual(s.out[0].payload.status, "persisted");
    assert.strictEqual(got.serverName, "Name");
  });

  it("a retransmit that arrives while the first is still in flight is not processed twice", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const router = mk({
      discordLogger: {
        logCommand: async () => {
          calls++;
          await gate;
        },
      },
    });
    const s = sess();
    const e = env({ id: "same", type: "log.command" });
    const p1 = router.handleEnvelope(s, e);
    const p2 = router.handleEnvelope(s, e);
    release();
    await Promise.all([p1, p2]);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(s.out.map((a) => a.payload.status), ["persisted", "duplicate"]);
  });

  it("releases the claim when processing fails so the sender can retry", async () => {
    let fail = true;
    const router = mk({
      discordLogger: {
        logCommand: async () => {
          if (fail) throw new Error("boom");
        },
      },
    });
    const s = sess();
    const e = env({ id: "retry", type: "log.command" });
    await router.handleEnvelope(s, e);
    assert.strictEqual(s.out[0].payload.status, "error");
    fail = false;
    await router.handleEnvelope(s, e);
    assert.strictEqual(s.out[1].payload.status, "persisted");
  });

  it("applies events from one session in arrival order", async () => {
    const order = [];
    const router = mk({
      discordLogger: {
        logCommand: async (p) => {
          await new Promise((r) => setTimeout(r, p.n === 1 ? 30 : 1));
          order.push(p.n);
        },
      },
    });
    const s = sess();
    await Promise.all([1, 2, 3].map((n) => router.handleEnvelope(s, env({ type: "log.command", payload: { n } }))));
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("rejects malformed Steam IDs, clamps playtime and link TTL", async () => {
    const calls = {};
    const router = mk({
      statsRepo: { recordPlaytime: (...a) => (calls.play = a), updatePlayerSeen: () => (calls.seen = true) },
      linkService: { handleLinkRequestedEvent: (a) => (calls.link = a) },
    });
    const s = sess();
    await router.handleEnvelope(s, env({ type: "player.session.ended", payload: { steamId: "not-a-steam-id", durationSeconds: 5 } }));
    assert.strictEqual(calls.play, undefined);
    await router.handleEnvelope(s, env({ type: "player.session.ended", payload: { steamId: "76561198000000001", durationSeconds: 1e12 } }));
    assert.strictEqual(calls.play[2], 30 * 86400);
    await router.handleEnvelope(s, env({ type: "player.link.requested", payload: { code: "ABC123", steamId: "76561198000000001", ttlSeconds: 99999999 } }));
    assert.strictEqual(calls.link.ttlSeconds, 900);
  });

  it("snapshots are idempotent and skip the dedupe table", async () => {
    const router = mk();
    const s = sess();
    await router.handleEnvelope(s, env({ id: "snap", type: "server.snapshot", payload: {} }));
    assert.ok(!dedupe.isEventProcessed("real", "snap"));
    assert.strictEqual(s.out[0].payload.status, "persisted");
  });
});

describe("Link brute force and code hygiene", () => {
  it("locks a Discord user out after repeated invalid codes, then recovers", async () => {
    let t = 0;
    const svc = new LinkService({
      linkRepo: new LinkRepository(new DatabaseManager(":memory:")),
      maxBadAttempts: 3,
      lockoutMs: 60_000,
      now: () => t,
    });
    for (let i = 0; i < 3; i++) assert.match((await svc.redeemCode({ code: "NOPE" + i, discordId: "111" })).error, /Invalid or expired/);
    assert.match((await svc.redeemCode({ code: "NOPE9", discordId: "111" })).error, /Too many invalid/);
    assert.match((await svc.redeemCode({ code: "NOPE9", discordId: "222" })).error, /Invalid or expired/, "other users unaffected");
    t += 61_000;
    assert.match((await svc.redeemCode({ code: "NOPE9", discordId: "111" })).error, /Invalid or expired/);
  });

  it("keeps only one pending code per player", () => {
    const repo = new LinkRepository(new DatabaseManager(":memory:"));
    repo.storeCode("AAAAAA", "76561198000000001", "P", "s1");
    repo.storeCode("BBBBBB", "76561198000000001", "P", "s1");
    assert.strictEqual(repo.consumeCode("AAAAAA"), null);
    assert.ok(repo.consumeCode("BBBBBB"));
  });
});

describe("Guild lock", () => {
  it("first claim pins the guild; other guilds are refused", () => {
    const db = new DatabaseManager(":memory:");
    const p = new GuildPolicy({ dbManager: db, guildRepo: new GuildRepository(db) });
    assert.ok(p.isUnclaimed);
    assert.ok(p.claimIfUnclaimed("100000"));
    assert.ok(!p.claimIfUnclaimed("200000"), "second guild cannot claim");
    assert.ok(p.isAllowed("100000") && !p.isAllowed("200000"));
    assert.ok(new GuildPolicy({ dbManager: db, guildRepo: new GuildRepository(db) }).isAllowed("100000"), "persisted across restarts");
  });

  it("migrates existing installs by pinning already-configured guilds", () => {
    const db = new DatabaseManager(":memory:");
    const repo = new GuildRepository(db);
    repo.upsertGuildConfig("555555", { chatChannelId: "c" });
    const p = new GuildPolicy({ dbManager: db, guildRepo: repo });
    assert.ok(p.isAllowed("555555") && !p.isUnclaimed && !p.isAllowed("666666"));
  });

  it("config guildIds are honoured and block claiming", () => {
    const db = new DatabaseManager(":memory:");
    const p = new GuildPolicy({ dbManager: db, guildRepo: new GuildRepository(db), configuredIds: ["777777"] });
    assert.ok(p.isAllowed("777777") && !p.claimIfUnclaimed("888888"));
  });
});

describe("Moderation targeting", () => {
  const ws = (ids) => ({ getActiveSessions: () => ids.map((serverId) => ({ serverId, isClosed: false })), getSession: () => null });
  const audit = { recordAudit() {} };

  it("refuses an untargeted command when several servers exist", async () => {
    const svc = new ModerationService({ wsServer: ws(["a", "b"]), auditRepo: audit });
    await assert.rejects(svc.executeConsoleCommand({ rawCommand: "save", requestedByDiscordId: "1" }), /Specify which one/);
  });

  it("Pterodactyl fallback never stands in for a different server", async () => {
    let sent = 0;
    const ptero = { isConfigured: () => true, sendCommand: async () => { sent++; } };
    const svc = new ModerationService({
      wsServer: ws([]),
      auditRepo: audit,
      pterodactylClient: ptero,
      listKnownServerIds: () => ["a", "b"],
      pterodactylServerId: "a",
    });
    await assert.rejects(svc.executeConsoleCommand({ rawCommand: "save", serverId: "b", requestedByDiscordId: "1" }), /not currently connected/);
    assert.strictEqual(sent, 0);
    const ok = await svc.executeConsoleCommand({ rawCommand: "save", serverId: "a", requestedByDiscordId: "1" });
    assert.strictEqual(ok.executedVia, "pterodactyl");
  });
});

describe("Chat relay flood guard and fan-out", () => {
  it("rate-limits a single Discord user", () => {
    const relay = new ChatRelay({ discordClient: {}, wsServer: {}, guildRepo: {} });
    assert.ok(relay.allowUser("u", 10000));
    assert.ok(!relay.allowUser("u", 10500));
    assert.ok(relay.allowUser("u", 13000));
  });

  it("relays to all servers in parallel (total time ~ slowest, not the sum)", async () => {
    const guildRepo = { getAllGuildConfigs: () => [{ chatChannelId: "c1" }] };
    const slow = (serverId) => ({ serverId, sendCommand: () => new Promise((r) => setTimeout(() => r({ payload: { delivered: true } }), 120)) });
    const relay = new ChatRelay({ discordClient: {}, wsServer: { getActiveSessions: () => [slow("a"), slow("b"), slow("c")] }, guildRepo });
    let reacted = false;
    const t0 = Date.now();
    await relay.handleDiscordMessage({
      id: "m1",
      channelId: "c1",
      author: { id: "u", username: "u" },
      cleanContent: "hello",
      react: async () => { reacted = true; },
    });
    assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0}ms; sequential would be ~360ms`);
    assert.ok(reacted);
  });
});
