const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { LinkRepository } = require("../src/database/repositories/linkRepository");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { RoleSyncManager } = require("../src/discord/roles/roleSync");

describe("Linked Role Sync Decision Logic", () => {
  let db;
  let linkRepo;
  let guildRepo;
  let roleSyncManager;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    linkRepo = new LinkRepository(db);
    guildRepo = new GuildRepository(db);
    roleSyncManager = new RoleSyncManager({
      linkRepo,
      guildRepo,
      discordClient: null,
    });
  });

  it("should calculate correct role sync decision action", () => {
    // 1. Linked but missing role -> must ADD
    assert.strictEqual(roleSyncManager.determineRoleSyncAction(true, false), "ADD");

    // 2. Linked and already has role -> NOOP
    assert.strictEqual(roleSyncManager.determineRoleSyncAction(true, true), "NOOP");

    // 3. Not linked but still has role -> must REMOVE
    assert.strictEqual(roleSyncManager.determineRoleSyncAction(false, true), "REMOVE");

    // 4. Not linked and doesn't have role -> NOOP
    assert.strictEqual(roleSyncManager.determineRoleSyncAction(false, false), "NOOP");
  });

  it("should return NOOP when no linked role is configured in the guild", async () => {
    const fakeMember = {
      id: "user-123",
      user: { bot: false },
      guild: { id: "guild-456" },
      roles: { cache: new Set() },
    };

    // No config saved for guild-456
    const action = await roleSyncManager.syncMember(fakeMember);
    assert.strictEqual(action, "NOOP");
  });

  it("should add role when user is linked and has not received the role yet", async () => {
    const guildId = "guild-100";
    const linkedRoleId = "role-linked-999";
    const discordId = "discord-user-1";

    guildRepo.upsertGuildConfig(guildId, { linkedRoleId });
    linkRepo.linkAccount("76561198000000009", discordId);

    const rolesSet = new Set();
    let roleAdded = null;

    const fakeMember = {
      id: discordId,
      user: { bot: false },
      guild: { id: guildId },
      roles: {
        cache: {
          has: (r) => rolesSet.has(r),
        },
        add: async (r) => {
          roleAdded = r;
          rolesSet.add(r);
        },
        remove: async () => {},
      },
    };

    const result = await roleSyncManager.syncMember(fakeMember);
    assert.strictEqual(result, "ADDED");
    assert.strictEqual(roleAdded, linkedRoleId);
  });

  it("should remove role when user unlinks and still holds the role", async () => {
    const guildId = "guild-100";
    const linkedRoleId = "role-linked-999";
    const discordId = "discord-user-unlinked";

    guildRepo.upsertGuildConfig(guildId, { linkedRoleId });
    // Note: discordId is NOT linked in linkRepo

    const rolesSet = new Set([linkedRoleId]);
    let roleRemoved = null;

    const fakeMember = {
      id: discordId,
      user: { bot: false },
      guild: { id: guildId },
      roles: {
        cache: {
          has: (r) => rolesSet.has(r),
        },
        add: async () => {},
        remove: async (r) => {
          roleRemoved = r;
          rolesSet.delete(r);
        },
      },
    };

    const result = await roleSyncManager.syncMember(fakeMember);
    assert.strictEqual(result, "REMOVED");
    assert.strictEqual(roleRemoved, linkedRoleId);
  });
});
