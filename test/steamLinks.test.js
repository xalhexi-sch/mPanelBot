const { describe, it } = require("node:test");
const assert = require("node:assert");
const { SteamAvatarService, estimateSteamAccountAge } = require("../src/services/steamAvatar");
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

describe("vanity resolution via Steam Web API", () => {
  it("uses the API first and skips the XML profile on success", async () => {
    const urls = [];
    const s = new SteamAvatarService({ apiKey: "KEY", sleep: noSleep, minGapMs: 0, fetchImpl: async (u) => (urls.push(u), res(200, JSON.stringify({ response: { success: 1, steamid: ID } }))) });
    assert.strictEqual(await s.resolveVanity("Foo"), ID);
    assert.strictEqual(urls.length, 1);
    assert.match(urls[0], /ResolveVanityURL\/v0001\/\?key=KEY&vanityurl=foo$/);
  });

  it("falls back to XML, then HTML, when the API fails", async () => {
    const mk = (xmlBody, htmlBody) => new SteamAvatarService({ apiKey: "KEY", sleep: noSleep, minGapMs: 0, fetchImpl: async (u) =>
      u.includes("api.steampowered") ? res(200, JSON.stringify({ response: { success: 42 } })) : u.endsWith("?xml=1") ? res(200, xmlBody) : res(200, htmlBody) });
    assert.strictEqual(await mk(`<steamID64>${ID}</steamID64>`, "").resolveVanity("foo"), ID);
    assert.strictEqual(await mk("", `g_rgProfileData = {"steamid":"${ID}"}`).resolveVanity("foo"), ID);
    assert.strictEqual(await mk("", "").resolveVanity("foo"), null);
  });
});

describe("steam link replies", () => {
  const steam = { resolveVanity: async (v) => (v === "good" ? ID : null) };

  it("answers numeric links without any lookup and reports failures per link", async () => {
    const reply = await buildSteamLinkReply(`https://steamcommunity.com/profiles/${ID} https://steamcommunity.com/id/good https://steamcommunity.com/id/bad`, steam);
    assert.strictEqual(reply, [ID, ID, "bad not found"].join("\n"));
  });

  it("does not reply to bots, webhooks, DMs or messages without links", async () => {
    const sent = [];
    const msg = (extra) => ({ guildId: "g", author: {}, content: `https://steamcommunity.com/profiles/${ID}`, reply: async (t) => sent.push(t), ...extra });
    await handleSteamLinkMessage(msg({ author: { bot: true } }), steam);
    await handleSteamLinkMessage(msg({ webhookId: "w" }), steam);
    await handleSteamLinkMessage(msg({ content: "hello" }), steam);
    assert.strictEqual(sent.length, 0);
    await handleSteamLinkMessage(msg(), steam);
    assert.strictEqual(sent.length, 1);
    await handleSteamLinkMessage(msg({ guildId: null }), steam); // DMs work too
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].content, ID);
  });
});

describe("profile lookup via Steam Web API", () => {
  it("fetches avatar and createdUnix via GetPlayerSummaries when apiKey is set", async () => {
    const urls = [];
    const s = new SteamAvatarService({
      apiKey: "SECRET_KEY",
      sleep: noSleep,
      minGapMs: 0,
      fetchImpl: async (u) => {
        urls.push(u);
        return res(200, JSON.stringify({
          response: {
            players: [
              {
                steamid: ID,
                avatarfull: "https://avatars.steamstatic.com/test_full.jpg",
                timecreated: 1645833600,
              },
            ],
          },
        }));
      },
    });

    const prof = await s.getProfile(ID);
    assert.strictEqual(urls.length, 1);
    assert.match(urls[0], /GetPlayerSummaries\/v0002\/\?key=SECRET_KEY&steamids=76561199246661188/);
    assert.strictEqual(prof.avatarUrl, "https://avatars.steamstatic.com/test_full.jpg");
    assert.strictEqual(prof.createdUnix, 1645833600);
  });

  it("falls back to XML profile if Steam Web API returns no players", async () => {
    const s = new SteamAvatarService({
      apiKey: "SECRET_KEY",
      sleep: noSleep,
      minGapMs: 0,
      fetchImpl: async (u) => {
        if (u.includes("GetPlayerSummaries")) {
          return res(200, JSON.stringify({ response: { players: [] } }));
        }
        return res(200, `<profile><avatarFull><![CDATA[https://cdn/xml_avatar.jpg]]></avatarFull><memberSince>May 27, 2015</memberSince></profile>`);
      },
    });

    const prof = await s.getProfile("76561198230689552");
    assert.strictEqual(prof.avatarUrl, "https://cdn/xml_avatar.jpg");
    assert.strictEqual(prof.createdUnix, Math.floor(Date.parse("May 27, 2015 UTC") / 1000));
  });
});

describe("estimateSteamAccountAge", () => {
  it("estimates account creation year from sequential Steam64 ID", () => {
    const umaEst = estimateSteamAccountAge("76561198230689552");
    assert.ok(umaEst);
    const date = new Date(umaEst * 1000);
    assert.strictEqual(date.getUTCFullYear(), 2015);

    const ecEst = estimateSteamAccountAge("76561199246661188");
    assert.ok(ecEst);
    const dateEc = new Date(ecEst * 1000);
    assert.strictEqual(dateEc.getUTCFullYear(), 2022);
  });

  it("returns null for malformed or non-user Steam IDs", () => {
    assert.strictEqual(estimateSteamAccountAge("not_a_number"), null);
    assert.strictEqual(estimateSteamAccountAge("123"), null);
  });
});
