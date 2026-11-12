const { describe, it } = require("node:test");
const assert = require("node:assert");
const { SteamAvatarService } = require("../src/services/steamAvatar");
const { extractSteamLinks, buildSteamLinkReply, handleSteamLinkMessage } = require("../src/discord/steamLinks");

const ID = "76561199246661188";
const res = (status, body = "") => ({ status, ok: status >= 200 && status < 300, text: async () => body, headers: { get: () => null } });
const noSleep = async () => {};
const svc = (fetchImpl) => new SteamAvatarService({ fetchImpl, sleep: noSleep, minGapMs: 0 });

describe("steam link extraction", () => {
  it("finds profile and vanity links, dedupes, and caps the count", () => {
    const links = extractSteamLinks(
      `a https://steamcommunity.com/profiles/${ID} b https://steamcommunity.com/id/Foo c https://steamcommunity.com/id/foo/ d https://steamcommunity.com/profiles/${ID}`,
    );
    assert.deepStrictEqual(links.map((l) => l.label), [ID, "Foo"]);
    const many = Array.from({ length: 12 }, (_, i) => `https://steamcommunity.com/id/user${i}`).join(" ");
    assert.strictEqual(extractSteamLinks(many).length, 5);
  });

  it("ignores lookalike domains and malformed ids", () => {
    assert.strictEqual(extractSteamLinks("https://evilsteamcommunity.com.example/id/foo").length, 0);
    assert.strictEqual(extractSteamLinks("https://steamcommunity.com/profiles/123").length, 0);
  });
});

describe("vanity resolution", () => {
  it("resolves via the XML profile and caches the answer", async () => {
    let calls = 0;
    const s = svc(async (url) => (calls++, assert.match(url, /\/id\/foo\?xml=1$/), res(200, `<profile><steamID64>${ID}</steamID64></profile>`)));
    assert.strictEqual(await s.resolveVanity("Foo"), ID);
    assert.strictEqual(await s.resolveVanity("foo"), ID);
    assert.strictEqual(calls, 1);
  });

  it("returns null for unknown profiles, outages and invalid names without throwing", async () => {
    assert.strictEqual(await svc(async () => res(200, "<response><error><![CDATA[not found]]></error></response>")).resolveVanity("nobody"), null);
    assert.strictEqual(await svc(async () => { throw new Error("offline"); }).resolveVanity("nobody"), null);
    assert.strictEqual(await svc(async () => res(200, "")).resolveVanity("a/../b"), null);
  });
});

describe("steam link replies", () => {
  const steam = { resolveVanity: async (v) => (v === "good" ? ID : null) };

  it("answers numeric links without any lookup and reports failures per link", async () => {
    const reply = await buildSteamLinkReply(`https://steamcommunity.com/profiles/${ID} https://steamcommunity.com/id/good https://steamcommunity.com/id/bad`, steam);
    assert.strictEqual(reply, [`**${ID}** → \`${ID}\``, `**good** → \`${ID}\``, "❌ **bad** → couldn't resolve a Steam64 ID"].join("\n"));
  });

  it("does not reply to bots, webhooks, DMs or messages without links", async () => {
    const sent = [];
    const msg = (extra) => ({ guildId: "g", author: {}, content: `https://steamcommunity.com/profiles/${ID}`, reply: async (t) => sent.push(t), ...extra });
    await handleSteamLinkMessage(msg({ author: { bot: true } }), steam);
    await handleSteamLinkMessage(msg({ webhookId: "w" }), steam);
    await handleSteamLinkMessage(msg({ guildId: null }), steam);
    await handleSteamLinkMessage(msg({ content: "hello" }), steam);
    assert.strictEqual(sent.length, 0);
    await handleSteamLinkMessage(msg(), steam);
    assert.strictEqual(sent.length, 1);
  });
});
