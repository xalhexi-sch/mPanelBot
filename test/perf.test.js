const { describe, it } = require("node:test");
const assert = require("node:assert");

const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { StatsRepository } = require("../src/database/repositories/statsRepository");
const { StatsService } = require("../src/services/statsService");

const silent = { warn() {}, log() {} };
const mysqlCfg = {
  enabled: true, host: "h", port: 3306, user: "u", password: "p", database: "d", table: "PlayerStats", playtimeUnit: "seconds",
  columns: { steamId: "SteamId", name: "Name", kills: "Kills", headshots: "Headshots", deaths: "PVPDeaths", playtime: "Playtime" },
};

function countingMysql() {
  const state = { queries: 0 };
  const row = { steamId: "76561198000000001", playerName: "A", kills: 1, headshots: 0, deaths: 0, playtime: 5 };
  return {
    state,
    createPool: () => ({
      query: async () => {
        state.queries++;
        await new Promise((r) => setTimeout(r, 5));
        return [[row]];
      },
      execute: async () => [[row]],
      end: async () => {},
    }),
  };
}

describe("stats cache (idle load)", () => {
  it("serves repeated leaderboard reads from cache and refreshes after the TTL", async () => {
    let t = 0;
    const mysql = countingMysql();
    const svc = new StatsService({ statsRepo: {}, mysqlConfig: mysqlCfg, mysqlModule: mysql, logger: silent, cacheMs: 60_000, now: () => t });

    await svc.getTop("kills", 10);
    await svc.getTop("kills", 10);
    await svc.getTop("kills", 10);
    assert.strictEqual(mysql.state.queries, 1, "three reads, one MySQL query");

    await svc.getTop("deaths", 10);
    assert.strictEqual(mysql.state.queries, 2, "different metric is a different key");

    t += 60_001;
    await svc.getTop("kills", 10);
    assert.strictEqual(mysql.state.queries, 3, "expired entry is refreshed");
  });

  it("collapses simultaneous identical requests into one query", async () => {
    const mysql = countingMysql();
    const svc = new StatsService({ statsRepo: {}, mysqlConfig: mysqlCfg, mysqlModule: mysql, logger: silent });
    await Promise.all(Array.from({ length: 20 }, () => svc.getTop("playtime", 10)));
    assert.strictEqual(mysql.state.queries, 1);
  });

  it("the SQLite source is cached briefly and refreshes after the TTL", async () => {
    let t = 0;
    const db = new DatabaseManager(":memory:");
    const repo = new StatsRepository(db);
    repo.recordKillCredit("76561198000000005", "Local", false);
    const svc = new StatsService({ statsRepo: repo, cacheMs: 1000, now: () => t });
    assert.strictEqual((await svc.getTop("kills", 5))[0].kills, 1);
    repo.recordKillCredit("76561198000000005", "Local", false);
    assert.strictEqual((await svc.getTop("kills", 5))[0].kills, 1, "still cached");
    t += 1001;
    assert.strictEqual((await svc.getTop("kills", 5))[0].kills, 2, "fresh after TTL");
    db.close();
  });
});

describe("guild config cache", () => {
  it("reads the database once, invalidates on upsert, and cannot be corrupted by callers", () => {
    const db = new DatabaseManager(":memory:");
    const repo = new GuildRepository(db);
    repo.upsertGuildConfig("g1", { chatChannelId: "1" });

    let selects = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/FROM guild_configs/i.test(sql) && /^\s*SELECT \* FROM guild_configs\s*$/i.test(sql)) selects++;
      return realPrepare(sql);
    };

    for (let i = 0; i < 50; i++) repo.getAllGuildConfigs();
    assert.strictEqual(selects, 1, "50 reads, 1 query");

    // callers mutate what they get
    const cfgs = repo.getAllGuildConfigs();
    cfgs[0].chatChannelId = "HACKED";
    cfgs[0].adminRoleIds.push("evil");
    assert.strictEqual(repo.getAllGuildConfigs()[0].chatChannelId, "1");
    assert.deepStrictEqual(repo.getAllGuildConfigs()[0].adminRoleIds, []);

    repo.upsertGuildConfig("g1", { chatChannelId: "2" });
    assert.strictEqual(repo.getAllGuildConfigs()[0].chatChannelId, "2", "upsert invalidates");
    assert.strictEqual(selects, 2);
    db.close();
  });
});
