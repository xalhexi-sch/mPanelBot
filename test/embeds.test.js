const { describe, it } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { GuildRepository } = require("../src/database/repositories/guildRepository");
const { buildRaidAlertEmbed, buildLinkPanelEmbed, buildLinkPanelComponents, buildLinkSuccessEmbed, LINK_PANEL_BUTTON_ID } = require("../src/discord/views");

const ID = "76561199246661188";
const alert = { objectName: "Metal Wall", location: "Kuwait Airport", attackerName: "Raider", attackerSteamId: ID, weapon: "C4" };

describe("raid alert embed", () => {
  it("hides the raider when disabled and shows it when enabled", () => {
    const hidden = buildRaidAlertEmbed(alert, { showRaider: false }).toJSON();
    assert.strictEqual(hidden.title, "🚨 Raid Alert!");
    assert.strictEqual(hidden.description, "Your **Metal Wall** near **Kuwait Airport** has been destroyed.");
    assert.strictEqual(hidden.fields, undefined);
    const shown = buildRaidAlertEmbed(alert, { showRaider: true }).toJSON();
    assert.strictEqual(
      shown.description,
      `Your **Metal Wall** near **Kuwait Airport** has been destroyed by [Raider](https://steamcommunity.com/profiles/${ID})!`
    );
    assert.strictEqual(shown.fields[0].value, "C4");
  });

  it("hides coordinate-only locations and renders the finished state", () => {
    assert.match(buildRaidAlertEmbed({ ...alert, location: "123.4, 56.7, 8" }).toJSON().description, /near \*\*Unknown\*\*/);
    const done = buildRaidAlertEmbed(alert, { isFinished: true }).toJSON();
    assert.strictEqual(done.title, "✅ Finished Raid Alert!");
    assert.strictEqual(done.fields, undefined);
  });
});

describe("link embeds", () => {
  it("builds the panel, button and success embed", () => {
    assert.match(buildLinkPanelEmbed().toJSON().title, /Link Your Steam Account/);
    assert.strictEqual(buildLinkPanelComponents()[0].toJSON().components[0].custom_id, LINK_PANEL_BUTTON_ID);
    assert.match(buildLinkSuccessEmbed({ playerName: "Bob", steamId: ID }).toJSON().description, new RegExp(ID));
  });

  it("persists the link panel message ids per guild", () => {
    const repo = new GuildRepository(new DatabaseManager(":memory:"));
    repo.upsertGuildConfig("g1", { linkChannelId: "c1", linkMessageId: "m1" });
    const cfg = repo.getGuildConfig("g1");
    assert.strictEqual(cfg.linkChannelId, "c1");
    assert.strictEqual(cfg.linkMessageId, "m1");
  });
});
