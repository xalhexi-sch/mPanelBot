const { describe, it } = require("node:test");
const assert = require("node:assert");

const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { SnapshotRepository } = require("../src/database/repositories/snapshotRepository");
const { StatsRepository } = require("../src/database/repositories/statsRepository");
const { StatsService, MySqlStatsSource } = require("../src/services/statsService");
const { LivePanels } = require("../src/discord/livePanels");
const { buildServerStatusEmbed, buildStatusEmbeds, buildLeaderboardEmbed, formatDuration, trimName, embedLength } = require("../src/discord/views");

const silent = { warn() {}, log() {} };

describe("views", () => {
  it("formats durations compactly", () => {
    assert.strictEqual(formatDuration(45), "45s");
    assert.strictEqual(formatDuration(3700), "1h 1m");
    assert.strictEqual(formatDuration(90000), "1d 1h");
  });

  it("strips markdown from names so they cannot break links", () => {
    assert.strictEqual(trimName("[evil](x)*name*"), "evilxname");
    assert.strictEqual(trimName(""), "Unknown");
  });

  it("renders an online server with a 3-column player grid padded to full rows", () => {
    const e = buildServerStatusEmbed(
      { serverId: "s1", serverName: "One", map: "PEI", onlinePlayers: 4, maxPlayers: 24, players: Array.from({ length: 4 }, (_, i) => ({ steamId: `7656119800000000${i}`, playerName: `P${i}`, pingMs: 10, sessionDurationSeconds: i * 60 })) },
      { online: true }
    ).toJSON();
    assert.match(e.title, /🟢 One/);
    assert.strictEqual(e.fields.length % 3, 0);
    assert.ok(e.description.includes("4/24"));
  });

  it("renders an offline server greyed out", () => {
    const e = buildServerStatusEmbed({ serverId: "s1", serverName: "One", updatedAtUtc: new Date().toISOString() }, { online: false }).toJSON();
    assert.match(e.title, /🔴/);
    assert.match(e.description, /Offline/);
  });

  it("renders the old-style leaderboard: underlined headers + one row per rank, within Discord limits", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ steam_id: `${i}`, player_name: "A".repeat(40), kills: 1e6, deaths: 1e6, playtime_seconds: 1e9 }));
    const e = buildLeaderboardEmbed({ kills: rows, playtime: rows, deaths: rows }).toJSON();
    assert.strictEqual(e.fields.length, 18);
    assert.strictEqual(e.fields[0].name, "__Most Kills__");
    assert.ok(e.fields[3].value.startsWith("> 🥇 **["));
    assert.match(e.fields[3].value, /\*\*AAAAAAAAAAAAA…\*\*|\*\*\[A+…\]/);
    for (const f of e.fields) assert.ok(f.value.length <= 1024);
  });
});

describe("status message size", () => {
  const mkServer = (i, players) => ({
    serverId: `server-${i}`,
    serverName: `A Rather Long Server Name Number ${i}`,
    map: "PEI",
    onlinePlayers: players,
    maxPlayers: 48,
    updatedAtUtc: new Date().toISOString(),
    players: Array.from({ length: players }, (_, p) => ({ steamId: `7656119800000${i}${String(p).padStart(4, "0")}`, playerName: "N".repeat(30), characterName: "C".repeat(30), pingMs: 123, sessionDurationSeconds: 99999 + p })),
  });

  for (const servers of [1, 3, 6, 10]) {
    it(`stays under Discord's 6000-char embed limit with ${servers} full server(s)`, () => {
      const snaps = Array.from({ length: servers }, (_, i) => mkServer(i, 40));
      const embeds = buildStatusEmbeds(snaps, new Set(snaps.map((s) => s.serverId)));
      const total = embeds.reduce((n, e) => n + embedLength(e), 0);
      assert.ok(total <= 6000, `total ${total}`);
      assert.ok(embeds.length <= 10);
      for (const e of embeds) assert.ok(e.toJSON().fields.length <= 25);
    });
  }
});

describe("MySQL stats source (optional)", () => {
  const cfg = {
    enabled: true, host: "h", port: 3306, user: "u", password: "p", database: "d", table: "PlayerStats", playtimeUnit: "minutes",
    columns: { steamId: "SteamId", name: "Name", kills: "Kills", headshots: "Headshots", deaths: "PVPDeaths", playtime: "Playtime" },
  };

  function fakeMysql(handler) {
    const calls = [];
    return {
      calls,
      createPool: () => ({
        execute: async (sql, params) => (calls.push({ sql, params }), handler(sql, params)),
        query: async (sql, params) => (calls.push({ sql, params }), handler(sql, params)),
        end: async () => {},
      }),
    };
  }

  it("reads legacy PlayerStats rows, converts minutes to seconds and uses parameterised SQL", async () => {
    const mysql = fakeMysql((sql) => {
      if (/COUNT\(\*\) AS total/.test(sql)) return [[{ total: 50 }]];
      if (/COUNT\(\*\) \+ 1/.test(sql)) return [[{ rnk: 3 }]];
      return [[{ steamId: "76561198000000001", playerName: "Legacy", kills: 10, headshots: 4, deaths: 5, playtime: 120 }]];
    });
    const svc = new StatsService({ statsRepo: {}, mysqlConfig: cfg, mysqlModule: mysql, logger: silent });
    assert.strictEqual(svc.source, "mysql");
    const s = await svc.getStats("76561198000000001");
    assert.strictEqual(s.playtimeSeconds, 7200);
    assert.strictEqual(s.rank, 3);
    assert.strictEqual(s.total, 50);
    assert.ok(mysql.calls.some((c) => /WHERE `SteamId` = \?/.test(c.sql) && c.params[0] === "76561198000000001"));
  });

  it("rejects hostile identifiers in the configuration", () => {
    assert.throws(() => new MySqlStatsSource({ ...cfg, table: "x; DROP TABLE y" }, fakeMysql(() => [[]])));
  });

  it("falls back to SQLite when MySQL fails", async () => {
    const db = new DatabaseManager(":memory:");
    const repo = new StatsRepository(db);
    repo.recordKillCredit("76561198000000005", "Local", false);
    const mysql = fakeMysql(() => {
      throw new Error("ECONNREFUSED");
    });
    const svc = new StatsService({ statsRepo: repo, mysqlConfig: cfg, mysqlModule: mysql, logger: silent });
    const top = await svc.getTop("kills", 10);
    assert.strictEqual(top[0].steam_id, "76561198000000005");
    db.close();
  });
});

describe("live panels", () => {
  function setup() {
    const db = new DatabaseManager(":memory:");
    const guildRepo = new GuildRepository(db, "secret");
    const snapshotRepo = new SnapshotRepository(db);
    const statsRepo = new StatsRepository(db);
    snapshotRepo.saveSnapshot("s1", { serverName: "One", map: "PEI", onlinePlayers: 1, maxPlayers: 10, players: [{ steamId: "1", playerName: "A", pingMs: 5, sessionDurationSeconds: 5 }] });
    statsRepo.recordKillCredit("76561198000000001", "A", true);

    const sent = [];
    const edits = [];
    const store = new Map();
    const channel = {
      isTextBased: () => true,
      send: async (p) => (sent.push(p), { id: "m1" }),
      messages: { fetch: async (id) => (store.has(id) ? { edit: async (p) => edits.push(p) } : Promise.reject(new Error("Unknown Message"))) },
    };
    const client = { channels: { fetch: async () => channel } };
    const panels = new LivePanels({ client, guildRepo, snapshotRepo, statsService: new StatsService({ statsRepo }), wsServer: { getActiveSessions: () => [{ serverId: "s1" }] }, logger: silent });
    return { db, guildRepo, panels, sent, edits, store };
  }

  it("persists channel + message ids in SQLite and edits in place afterwards", async () => {
    const { db, guildRepo, panels, sent, edits, store } = setup();
    guildRepo.upsertGuildConfig("g1", { statusChannelId: "c1", leaderboardChannelId: "c2" });

    await panels.refreshAll();
    assert.strictEqual(sent.length, 2, "one status + one leaderboard message posted");
    const cfg = guildRepo.getGuildConfig("g1");
    assert.strictEqual(cfg.statusMessageId, "m1");
    assert.strictEqual(cfg.leaderboardMessageId, "m1");

    store.set("m1", true); // the message exists now
    await panels.refreshPanel(guildRepo.getGuildConfig("g1"), "status");
    assert.strictEqual(sent.length, 2, "no duplicate message");
    db.close();
  });

  it("does not re-send identical content (rate-limit friendly)", async () => {
    const { db, guildRepo, panels, edits, store } = setup();
    store.set("m1", true);
    guildRepo.upsertGuildConfig("g1", { leaderboardChannelId: "c2", leaderboardMessageId: "m1" });
    const cfg = guildRepo.getGuildConfig("g1");
    assert.strictEqual(await panels.refreshPanel(cfg, "leaderboard"), true);
    assert.strictEqual(await panels.refreshPanel(cfg, "leaderboard"), false);
    assert.strictEqual(edits.length, 1);
    db.close();
  });

  it("never posts two messages when refreshes overlap", async () => {
    const { db, guildRepo, panels, sent } = setup();
    guildRepo.upsertGuildConfig("g1", { statusChannelId: "c1" });
    const cfg = guildRepo.getGuildConfig("g1");
    await Promise.all([panels.refreshPanel(cfg, "status"), panels.refreshPanel({ ...cfg }, "status"), panels.refreshAll("status")]);
    assert.strictEqual(sent.length, 1);
    db.close();
  });

  it("posts a fresh message when the old one was deleted", async () => {
    const { db, guildRepo, panels, sent } = setup();
    guildRepo.upsertGuildConfig("g1", { statusChannelId: "c1", statusMessageId: "gone" });
    await panels.refreshPanel(guildRepo.getGuildConfig("g1"), "status");
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(guildRepo.getGuildConfig("g1").statusMessageId, "m1");
    db.close();
  });
});

describe("guild repository", () => {
  it("round-trips every setting and keeps the webhook encrypted at rest", () => {
    const db = new DatabaseManager(":memory:");
    const repo = new GuildRepository(db, "k");
    repo.upsertGuildConfig("g", { chatWebhookUrl: "https://discord.com/api/webhooks/1/abc", statusChannelId: "10", adminRoleIds: ["5"] });
    const cfg = repo.getGuildConfig("g");
    assert.strictEqual(cfg.chatWebhookUrl, "https://discord.com/api/webhooks/1/abc");
    assert.strictEqual(cfg.statusChannelId, "10");
    assert.deepStrictEqual(cfg.adminRoleIds, ["5"]);
    const raw = db.prepare("SELECT chat_webhook_url FROM guild_configs WHERE guild_id = ?").get("g").chat_webhook_url;
    assert.ok(!raw.includes("abc"), "webhook must not be stored in plaintext");
    // partial update keeps other fields
    repo.upsertGuildConfig("g", { leaderboardChannelId: "11" });
    assert.strictEqual(repo.getGuildConfig("g").statusChannelId, "10");
    db.close();
  });
});

describe("steam profile, join card and farmbots", () => {
  const { SteamAvatarService } = require("../src/services/steamAvatar");
  const { DiscordLogger } = require("../src/discord/logs/discordLogger");
  const { buildFarmbotsEmbed } = require("../src/discord/views");

  const xml = (body) => ({ ok: true, text: async () => body });

  it("parses avatar + account creation date and group name from Steam XML, with caching", async () => {
    let calls = 0;
    const svc = new SteamAvatarService({
      fetchImpl: async (url) => {
        calls++;
        return String(url).includes("/gid/")
          ? xml("<memberList><groupDetails><groupName><![CDATA[Night &amp; Day]]></groupName><groupURL><![CDATA[nightday]]></groupURL></groupDetails></memberList>")
          : xml("<profile><avatarFull><![CDATA[https://cdn/x_full.jpg]]></avatarFull><memberSince>September 4, 2013</memberSince></profile>");
      },
    });
    const p = await svc.getProfile("76561198000000001");
    assert.strictEqual(p.avatarUrl, "https://cdn/x_full.jpg");
    assert.strictEqual(p.createdUnix, Date.UTC(2013, 8, 4) / 1000);
    await svc.getProfile("76561198000000001");
    assert.strictEqual(calls, 1, "second lookup served from cache");
    const g = await svc.getGroup("103582791475043382");
    assert.deepStrictEqual(g, { name: "Night & Day", url: "https://steamcommunity.com/groups/nightday" });
  });

  it("never throws when Steam is down", async () => {
    const svc = new SteamAvatarService({ fetchImpl: async () => { throw new Error("offline"); } });
    assert.deepStrictEqual(await svc.getProfile("76561198000000001"), { avatarUrl: null, createdUnix: null });
    assert.strictEqual(await svc.getGroup("103582791475043382"), null);
  });

  it("Player Joined card shows group, linked Discord user, account age and avatar thumbnail", async () => {
    const sent = [];
    const guildRepo = { getAllGuildConfigs: () => [{ guildId: "g", joinLeaveChannelId: "c" }] };
    const channel = { isTextBased: () => true, send: async (p) => sent.push(p) };
    const client = { guilds: { cache: new Map([["g", { channels: { cache: new Map([["c", channel]]) } }]]) } };
    const logger = new DiscordLogger({
      discordClient: client,
      guildRepo,
      linkRepo: { getLinkBySteam: () => ({ discord_id: "555" }) },
      avatars: { getProfile: async () => ({ avatarUrl: "https://cdn/a.jpg", createdUnix: 1378252800 }), getGroup: async () => ({ name: "Team Rocket", url: "https://steamcommunity.com/groups/tr" }) },
    });
    await logger.logPlayerConnected({ serverId: "s1", steamId: "76561198000000001", playerName: "Ash", group: { kind: "steam", id: "103582791475043382" } });
    const e = sent[0].embeds[0].toJSON();
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    assert.strictEqual(e.thumbnail.url, "https://cdn/a.jpg");
    assert.strictEqual(f.Discord, "<@555>");
    assert.strictEqual(f.Group, "[Team Rocket](https://steamcommunity.com/groups/tr)");
    assert.strictEqual(f.Created, "<t:1378252800:R>");
  });

  it("farmbots embed lists farmers / builders / gatherers like the old bot", () => {
    const e = buildFarmbotsEmbed({
      farmers: [{ steamId: "1", name: "Z", zombies: 10, mega: 2 }],
      builders: [{ steamId: "2", name: "B", structures: 5, barricades: 7 }],
      gatherers: [{ steamId: "3", name: "G", resources: 99 }],
    }).toJSON();
    assert.strictEqual(e.fields.length, 18);
    assert.match(e.fields[3].value, /\*\*10\*\* Zombies • \*\*2\*\* Mega • \*\*12\*\* Total/);
    assert.match(e.fields[4].value, /\*\*12\*\* Total/);
    assert.match(e.fields[5].value, /\*\*99\*\* Resources/);
  });
});
