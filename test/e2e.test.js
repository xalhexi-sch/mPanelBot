/**
 * End-to-end contract test: a fake plugin (real `ws` client, Bearer handshake) talks to the real
 * GameWebSocketServer + MessageRouter + SQLite repositories. Payloads mirror what the C# plugin emits
 * (ProtocolSerializer: camelCase, UTC ISO timestamps, nulls omitted) so a drift on either side fails here.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const { DatabaseManager } = require("../src/database");
const { LinkRepository } = require("../src/database/repositories/linkRepository");
const { DedupeRepository } = require("../src/database/repositories/dedupeRepository");
const { StatsRepository } = require("../src/database/repositories/statsRepository");
const { SnapshotRepository } = require("../src/database/repositories/snapshotRepository");
const { AuditRepository } = require("../src/database/repositories/auditRepository");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { GameWebSocketServer } = require("../src/websocket/server");
const { MessageRouter } = require("../src/websocket/router");
const { LinkService } = require("../src/services/linkService");
const { ModerationService } = require("../src/services/moderationService");
const { RaidNotifier } = require("../src/discord/raid/raidNotifier");
const { StatsService } = require("../src/services/statsService");

const API_KEY = "e2e-test-key-0123456789abcdef0123456789";
const SERVER_ID = "survival-1";
const KILLER = "76561198000000001";
const VICTIM = "76561198000000002";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await wait(10);
  }
  return false;
}

function envelope(kind, type, payload, extra = {}) {
  return {
    v: 1,
    id: crypto.randomUUID().replace(/-/g, ""),
    kind,
    type,
    serverId: SERVER_ID,
    occurredAtUtc: new Date().toISOString(),
    payload,
    ...extra,
  };
}

describe("plugin <-> bot end-to-end contract", () => {
  let httpServer, wsServer, db, repos, port, plugin, inbox, spies;

  before(async () => {
    db = new DatabaseManager(":memory:");
    repos = {
      link: new LinkRepository(db),
      dedupe: new DedupeRepository(db),
      stats: new StatsRepository(db),
      snapshot: new SnapshotRepository(db),
      audit: new AuditRepository(db),
      guild: new GuildRepository(db),
    };

    spies = { chat: [], commands: [], punishments: [], connected: [], disconnected: [], dms: [] };

    const discordLogger = {
      logPlayerConnected: async (d) => spies.connected.push(d),
      logPlayerDisconnected: async (d) => spies.disconnected.push(d),
      logCommand: async (d) => spies.commands.push(d),
      logPunishment: async (d) => spies.punishments.push(d),
    };
    const chatRelay = { handleGameChatEvent: async (d) => spies.chat.push(d) };

    // Real RaidNotifier with a stub Discord client: proves group fan-out reaches every linked member
    const linkA = { steam_id: KILLER, discord_id: "111", raid_alerts_dm: 1 };
    const linkB = { steam_id: VICTIM, discord_id: "222", raid_alerts_dm: 1 };
    const raidNotifier = new RaidNotifier({
      discordClient: { users: { fetch: async (id) => ({ send: async (m) => spies.dms.push({ id, m }) }) }, guilds: { cache: new Map(), fetch: async () => null } },
      linkRepo: { getLinkBySteam: (sid) => ({ [KILLER]: linkA, [VICTIM]: linkB })[sid] || null },
      guildRepo: { getAllGuildConfigs: () => [] },
    });

    wsServer = new GameWebSocketServer({
      apiKey: API_KEY,
      serverKeys: { [SERVER_ID]: API_KEY },
      heartbeatIntervalMs: 60000,
    });
    httpServer = http.createServer();
    wsServer.attach(httpServer);

    const linkService = new LinkService({ linkRepo: repos.link, onLinkCompleted: async () => {} });
    const router = new MessageRouter({
      dedupeRepo: repos.dedupe,
      snapshotRepo: repos.snapshot,
      statsRepo: repos.stats,
      linkService,
      discordLogger,
      raidNotifier,
      chatRelay,
      discordClient: { updatePresence() {} },
    });
    wsServer.on("envelope", (session, env) => router.handleEnvelope(session, env));

    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    port = httpServer.address().port;

    inbox = [];
    plugin = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    plugin.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((res, rej) => {
      plugin.once("open", res);
      plugin.once("error", rej);
    });
    plugin.send(
      JSON.stringify(
        envelope("hello", "system.hello", { serverId: SERVER_ID, pluginVersion: "1.0.0", serverName: "Survival One", protocolVersion: 1 })
      )
    );
    assert.ok(await until(() => inbox.some((m) => m.kind === "welcome")), "welcome frame expected");
    this_services = { repos, linkService };
  });

  let this_services;

  after(async () => {
    plugin?.close();
    wsServer?.close();
    httpServer?.close();
    db?.close();
  });

  const send = (type, payload, extra) => {
    const env = envelope("event", type, payload, extra);
    plugin.send(JSON.stringify(env));
    return env;
  };
  const acked = (env) => until(() => inbox.some((m) => m.kind === "ack" && m.correlationId === env.id));

  it("rejects a wrong API key during the handshake", async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: "Bearer nope" } });
    const outcome = await new Promise((res) => {
      bad.once("unexpected-response", (_r, resp) => res(resp.statusCode));
      bad.once("open", () => res("open"));
      bad.once("error", () => {});
    });
    assert.strictEqual(outcome, 401);
  });

  it("stores snapshots using the plugin's field names (onlinePlayers) and acks them", async () => {
    const env = send("server.snapshot", {
      serverId: SERVER_ID,
      serverName: "Survival One",
      map: "PEI",
      onlinePlayers: 2,
      maxPlayers: 24,
      isLevelLoaded: true,
      runtimeState: "Running",
      occurredAtUtc: new Date().toISOString(),
      players: [
        { steamId: KILLER, playerName: "Alpha", characterName: "Alpha", isOnline: true, pingMs: 42, sessionDurationSeconds: 600 },
        { steamId: VICTIM, playerName: "Bravo", characterName: "Bravo", isOnline: true, pingMs: 80, sessionDurationSeconds: 60 },
      ],
    });
    assert.ok(await acked(env));
    const snap = repos.snapshot.getSnapshot(SERVER_ID);
    assert.strictEqual(snap.onlineCount, 2);
    assert.strictEqual(snap.maxPlayers, 24);
    assert.strictEqual(snap.players.length, 2);
    assert.strictEqual(snap.players[0].pingMs, 42);
  });

  it("counts a PvP kill exactly once (player.kill + player.death both arrive)", async () => {
    const kill = send("player.kill", { killerSteamId: KILLER, killerName: "Alpha", victimSteamId: VICTIM, victimName: "Bravo", isHeadshot: true, cause: "GUN", limb: "SKULL" });
    const death = send("player.death", { victimSteamId: VICTIM, victimName: "Bravo", killerSteamId: KILLER, killerName: "Alpha", isPvP: true, isHeadshot: true, cause: "GUN", limb: "SKULL" });
    assert.ok(await acked(kill));
    assert.ok(await acked(death));

    const k = repos.stats.getStats(KILLER);
    const v = repos.stats.getStats(VICTIM);
    assert.strictEqual(k.kills, 1, "killer credited once");
    assert.strictEqual(k.headshots, 1);
    assert.strictEqual(k.deaths, 0);
    assert.strictEqual(v.deaths, 1, "victim debited once");
    assert.strictEqual(v.kills, 0);
  });

  it("an environmental death only counts a death", async () => {
    const env = send("player.death", { victimSteamId: VICTIM, victimName: "Bravo", isPvP: false, cause: "ZOMBIE" });
    assert.ok(await acked(env));
    assert.strictEqual(repos.stats.getStats(VICTIM).deaths, 2);
  });

  it("is idempotent: a retried event id does not double count", async () => {
    const env = envelope("event", "player.kill", { killerSteamId: KILLER, killerName: "Alpha", victimSteamId: VICTIM, victimName: "Bravo", isHeadshot: false });
    plugin.send(JSON.stringify(env));
    assert.ok(await acked(env));
    const before = repos.stats.getStats(KILLER).kills;
    inbox.length = 0;
    plugin.send(JSON.stringify(env)); // retry after "lost ack"
    assert.ok(await acked(env), "duplicate must still be acked so the plugin clears its outbox");
    assert.strictEqual(repos.stats.getStats(KILLER).kills, before);
  });

  it("accounts playtime only from player.session.ended (disconnect does not double count)", async () => {
    const dis = send("player.disconnected", { serverName: "Survival One", playerName: "Alpha", steamId: KILLER, sessionLengthSeconds: 900, timestampUtc: new Date().toISOString() });
    const ended = send("player.session.ended", { sessionId: "s1", steamId: KILLER, playerName: "Alpha", durationSeconds: 900, reason: "Disconnected" });
    assert.ok(await acked(dis));
    assert.ok(await acked(ended));
    assert.strictEqual(repos.stats.getStats(KILLER).playtimeSeconds, 900);
    assert.strictEqual(spies.disconnected.at(-1).durationSeconds, 900, "log still shows the session length");
  });

  it("routes chat, command and punishment logs with the plugin's field names", async () => {
    const chat = send("player.chat", { chatMode: "Global", serverName: "Survival One", playerName: "Alpha", steamId: KILLER, messageText: "hello world", source: "game", isRelayed: false });
    const cmd = send("log.command", { serverName: "Survival One", playerName: "Alpha", steamId: KILLER, commandText: "/home", normalizedCommand: "home" });
    const pun = send("log.punishment", { action: "ban", instigatorSteamId: KILLER, instigatorName: "Alpha", targetSteamId: VICTIM, targetName: "Bravo", reason: "cheating", durationSeconds: 3600 });
    for (const e of [chat, cmd, pun]) assert.ok(await acked(e));

    assert.strictEqual(spies.chat.at(-1).message, "hello world");
    assert.strictEqual(spies.chat.at(-1).mode, "Global");
    assert.strictEqual(spies.commands.at(-1).commandText, "/home");
    assert.strictEqual(spies.punishments.at(-1).instigatorName, "Alpha");
    assert.strictEqual(spies.punishments.at(-1).durationSeconds, 3600);
  });

  it("fans a raid alert out to every linked group member", async () => {
    const env = send("raid.alert", {
      alertId: "a1",
      ownerSteamId: KILLER,
      groupId: "g1",
      groupName: "Team",
      groupMemberSteamIds: [KILLER, VICTIM],
      onlineMemberSteamIds: [KILLER],
      objectType: "Barricade",
      objectName: "Metal Gate",
      location: "Kuwait",
      attackerSteamId: "76561198000000009",
      attackerName: "Raider",
      weaponName: "Maplestrike",
      isFinished: false,
    });
    assert.ok(await acked(env));
    assert.ok(await until(() => spies.dms.length === 2));
    assert.deepStrictEqual(spies.dms.map((d) => d.id).sort(), ["111", "222"]);
    const fields = spies.dms[0].m.embeds[0].toJSON().fields.map((f) => f.value);
    assert.ok(fields.some((v) => v.includes("Maplestrike")), "weapon comes from weaponName");
  });

  it("link code flow: player.link.requested -> redeem once -> second redeem rejected", async () => {
    const env = send("player.link.requested", { code: "ABC123", steamId: KILLER, playerName: "Alpha", ttlSeconds: 600 });
    assert.ok(await acked(env));
    const ok = await this_services.linkService.redeemCode({ code: "abc123", discordId: "111" });
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.serverId, SERVER_ID);
    const again = await this_services.linkService.redeemCode({ code: "ABC123", discordId: "333" });
    assert.strictEqual(again.success, false);
  });

  it("moderation command round trip: typed payload out, command.result back", async () => {
    plugin.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.kind !== "command") return;
      plugin.send(
        JSON.stringify(
          envelope("command.result", m.type, { commandId: m.id, correlationId: m.correlationId, success: true, message: "Banned", providerName: "Rocket" }, { correlationId: m.correlationId })
        )
      );
    });

    const moderation = new ModerationService({ wsServer, pterodactylClient: { isConfigured: () => false }, auditRepo: repos.audit });
    const result = await moderation.executeModeration({
      action: "ban",
      steam64: VICTIM,
      reason: "cheating",
      duration: "1h",
      serverId: SERVER_ID,
      requestedByDiscordId: "999",
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.executedVia, "websocket");

    const cmd = inbox.find((m) => m.kind === "command");
    assert.strictEqual(cmd.type, "server.command.request");
    assert.strictEqual(cmd.payload.command, "ban", "plugin resolves a typed action, not a free-form string");
    assert.strictEqual(cmd.payload.args.targetSteamId, VICTIM);
    assert.strictEqual(cmd.payload.args.duration, "60");
    assert.ok(cmd.correlationId);
    assert.ok(cmd.expiresAtUtc);
  });

  it("stats service reads what the router stored (SQLite source)", async () => {
    const svc = new StatsService({ statsRepo: repos.stats });
    assert.strictEqual(svc.source, "sqlite");
    const s = await svc.getStats(KILLER);
    assert.ok(s.kills >= 1);
    assert.strictEqual(s.rank, 1);
    const top = await svc.getTop("kills", 10);
    assert.strictEqual(top[0].steam_id, KILLER);
  });
});
