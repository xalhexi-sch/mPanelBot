const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { LinkedPermissionSync, loadLinkedPermissionConfig } = require("../src/services/linkedPermissionSync");

function fakeMysql(store) {
  const calls = [];
  return {
    calls,
    createPool: () => ({
      execute: async (sql, params = []) => {
        calls.push({ sql, params });
        const s = String(sql);

        if (/SELECT Id FROM/i.test(s)) {
          const [groupId, steamId, serverGroup] = params;
          const hit = store.rows.find(
            (r) => r.GroupId === groupId && r.SteamID === steamId && r.ServerGroup === serverGroup
          );
          return [hit ? [{ Id: hit.Id }] : []];
        }

        if (/SELECT CAST\(SteamID AS CHAR\)/i.test(s)) {
          const [groupId, serverGroup] = params;
          return [
            store.rows
              .filter((r) => r.GroupId === groupId && r.ServerGroup === serverGroup)
              .map((r) => ({ steamId: r.SteamID })),
          ];
        }

        if (/^INSERT INTO/i.test(s)) {
          const [groupId, steamId, createDate, serverGroup] = params;
          store.nextId += 1;
          store.rows.push({
            Id: store.nextId,
            GroupId: groupId,
            SteamID: steamId,
            CreateDate: createDate,
            ExpireDate: null,
            ServerGroup: serverGroup,
          });
          return [{ affectedRows: 1 }];
        }

        if (/^DELETE FROM/i.test(s)) {
          const [groupId, steamId, serverGroup] = params;
          const before = store.rows.length;
          store.rows = store.rows.filter(
            (r) => !(r.GroupId === groupId && r.SteamID === steamId && r.ServerGroup === serverGroup)
          );
          return [{ affectedRows: before - store.rows.length }];
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
      end: async () => {},
    }),
  };
}

describe("LinkedPermissionSync", () => {
  const mysqlConfig = {
    enabled: true,
    host: "127.0.0.1",
    port: 3306,
    user: "u",
    password: "p",
    database: "unturned",
  };

  const linkedConfig = {
    enabled: true,
    groupId: "linked",
    serverGroup: "PVP",
    table: "PermissionGroupMembers",
  };

  let store;
  let mysql;
  let linkRepo;

  beforeEach(() => {
    store = { nextId: 0, rows: [] };
    mysql = fakeMysql(store);
    linkRepo = {
      links: [],
      getAllLinks() {
        return this.links;
      },
    };
  });

  it("loadLinkedPermissionConfig requires enabled + groupId + mysql", () => {
    const cfg = loadLinkedPermissionConfig({ enabled: true, groupId: "linked" }, true);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.serverGroup, "PVP");
    assert.equal(loadLinkedPermissionConfig({ enabled: true, groupId: "" }, true).enabled, false);
    assert.equal(loadLinkedPermissionConfig({ enabled: true, groupId: "linked" }, false).enabled, false);
  });

  it("ensureMember inserts once then noops (idempotent)", async () => {
    const sync = new LinkedPermissionSync({
      mysqlConfig,
      linkedConfig,
      linkRepo,
      mysqlModule: mysql,
      logger: { log() {}, warn() {} },
      now: () => new Date("2026-11-13T00:00:00"),
    });

    const sid = "76561198000000001";
    assert.deepEqual(await sync.ensureMember(sid), { ok: true, action: "added" });
    assert.deepEqual(await sync.ensureMember(sid), { ok: true, action: "noop" });
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].GroupId, "linked");
    assert.equal(store.rows[0].SteamID, sid);
    assert.equal(store.rows[0].ExpireDate, null);
    assert.equal(store.rows[0].ServerGroup, "PVP");
  });

  it("removeMember deletes only the configured group row", async () => {
    store.rows.push(
      { Id: 1, GroupId: "linked", SteamID: "76561198000000001", CreateDate: "x", ExpireDate: null, ServerGroup: "PVP" },
      { Id: 2, GroupId: "captain", SteamID: "76561198000000001", CreateDate: "x", ExpireDate: null, ServerGroup: "PVP" }
    );

    const sync = new LinkedPermissionSync({
      mysqlConfig,
      linkedConfig,
      linkRepo,
      mysqlModule: mysql,
      logger: { log() {}, warn() {} },
    });

    const res = await sync.removeMember("76561198000000001");
    assert.equal(res.action, "removed");
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].GroupId, "captain");
  });

  it("reconcile adds missing linked players and removes stale group members", async () => {
    linkRepo.links = [
      { steam_id: "76561198000000001", discord_id: "d1" },
      { steam_id: "76561198000000002", discord_id: "d2" },
    ];
    store.rows.push(
      { Id: 9, GroupId: "linked", SteamID: "76561198000000099", CreateDate: "x", ExpireDate: null, ServerGroup: "PVP" },
      { Id: 10, GroupId: "captain", SteamID: "76561198000000099", CreateDate: "x", ExpireDate: null, ServerGroup: "PVP" }
    );

    const sync = new LinkedPermissionSync({
      mysqlConfig,
      linkedConfig,
      linkRepo,
      mysqlModule: mysql,
      logger: { log() {}, warn() {} },
    });

    const res = await sync.reconcile();
    assert.equal(res.ok, true);
    assert.equal(res.added, 2);
    assert.equal(res.removed, 1);

    const linkedRows = store.rows.filter((r) => r.GroupId === "linked");
    assert.deepEqual(
      linkedRows.map((r) => r.SteamID).sort(),
      ["76561198000000001", "76561198000000002"]
    );
    assert.ok(store.rows.some((r) => r.GroupId === "captain" && r.SteamID === "76561198000000099"));
  });

  it("stays disabled when mysql or groupId is missing", () => {
    const sync = new LinkedPermissionSync({
      mysqlConfig: { ...mysqlConfig, enabled: false },
      linkedConfig,
      linkRepo,
      mysqlModule: mysql,
      logger: { log() {}, warn() {} },
    });
    assert.equal(sync.enabled, false);
  });
});
