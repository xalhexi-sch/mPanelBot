const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { LinkRepository } = require("../src/database/repositories/linkRepository");
const { LinkService } = require("../src/services/linkService");

describe("Link Code Expiry, Consumption & Uniqueness", () => {
  let db;
  let linkRepo;
  let linkService;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    linkRepo = new LinkRepository(db);
    linkService = new LinkService({ linkRepo });
  });

  it("should store a code and allow consuming it before TTL expires", () => {
    linkRepo.storeCode("ABC123", "76561198000000001", "PlayerOne", "survival-1", 600);

    const consumed = linkRepo.consumeCode("ABC123");
    assert.ok(consumed);
    assert.strictEqual(consumed.steamId, "76561198000000001");
    assert.strictEqual(consumed.playerName, "PlayerOne");

    // Second consume must return null (one-time consumption)
    const secondConsume = linkRepo.consumeCode("ABC123");
    assert.strictEqual(secondConsume, null);
  });

  it("should reject expired code (TTL past)", () => {
    // Store code with negative TTL (already expired)
    linkRepo.storeCode("EXPIRED", "76561198000000002", "PlayerTwo", "survival-1", -10);

    const consumed = linkRepo.consumeCode("EXPIRED");
    assert.strictEqual(consumed, null);
  });

  it("should purge expired codes from database", () => {
    linkRepo.storeCode("VALID1", "76561198000000003", "Valid", "survival-1", 600);
    linkRepo.storeCode("DEAD01", "76561198000000004", "Dead", "survival-1", -50);

    linkRepo.purgeExpiredCodes();

    assert.ok(linkRepo.consumeCode("VALID1"));
    assert.strictEqual(linkRepo.consumeCode("DEAD01"), null);
  });

  it("should complete link redemption through LinkService and enforce 1:1 uniqueness", async () => {
    linkRepo.storeCode("LINK99", "76561198000000005", "Hero", "survival-1", 600);

    const res = await linkService.redeemCode({
      code: "LINK99",
      discordId: "123456789012345678",
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.steamId, "76561198000000005");
    assert.strictEqual(res.discordId, "123456789012345678");

    // Verify stored link
    const stored = linkRepo.getLinkByDiscord("123456789012345678");
    assert.ok(stored);
    assert.strictEqual(stored.steam_id, "76561198000000005");

    // Trying to link the same Discord user again should be prevented
    linkRepo.storeCode("CODE22", "76561198000000006", "Other", "survival-1", 600);
    const dupDiscord = await linkService.redeemCode({
      code: "CODE22",
      discordId: "123456789012345678",
    });
    assert.strictEqual(dupDiscord.success, false);
    assert.match(dupDiscord.error, /already linked/i);

    // Trying to link the same SteamID to a different Discord account should be prevented
    linkRepo.storeCode("CODE33", "76561198000000005", "Hero", "survival-1", 600);
    const dupSteam = await linkService.redeemCode({
      code: "CODE33",
      discordId: "987654321098765432",
    });
    assert.strictEqual(dupSteam.success, false);
    assert.match(dupSteam.error, /already linked/i);
  });
});
