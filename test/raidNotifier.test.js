const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { RaidNotifier } = require("../src/discord/raid/raidNotifier");

describe("RaidNotifier Filter & Delivery Rules", () => {
  function createHarness() {
    const sentDms = [];
    const sentChannels = [];

    const mockDiscordClient = {
      users: {
        async fetch(id) {
          return {
            id,
            async send(payload) {
              sentDms.push({ id, payload });
            },
          };
        },
      },
      guilds: {
        cache: new Map([
          [
            "guild-1",
            {
              channels: {
                cache: new Map([
                  [
                    "channel-raid-1",
                    {
                      isTextBased: () => true,
                      async send(payload) {
                        sentChannels.push({ guildId: "guild-1", channelId: "channel-raid-1", payload });
                      },
                    },
                  ],
                ]),
                async fetch(cid) {
                  return this.cache.get(cid);
                },
              },
            },
          ],
        ]),
        async fetch(gid) {
          return this.cache.get(gid);
        },
      },
    };

    const links = new Map([
      ["76561198000000001", { steam_id: "76561198000000001", discord_id: "123456789012345678", raid_alerts_dm: 1 }],
      ["76561198000000002", { steam_id: "76561198000000002", discord_id: "234567890123456789", raid_alerts_dm: 1 }],
    ]);

    const mockLinkRepo = {
      getLinkBySteam(sid) {
        return links.get(sid) || null;
      },
    };

    const mockGuildRepo = {
      getAllGuildConfigs() {
        return [
          {
            guildId: "guild-1",
            raidChannelId: "channel-raid-1",
          },
        ];
      },
    };

    const notifier = new RaidNotifier({
      discordClient: mockDiscordClient,
      linkRepo: mockLinkRepo,
      guildRepo: mockGuildRepo,
      showRaider: true,
    });

    return { notifier, sentDms, sentChannels };
  }

  it("should suppress C4/Charge when destroyed by Detonator", async () => {
    const { notifier, sentDms, sentChannels } = createHarness();

    await notifier.handleRaidAlert({
      ownerSteamId: "76561198000000001",
      attackerSteamId: "76561198000000002",
      objectName: "Breaching Charge",
      weapon: "Detonator",
      location: "Military Base",
    });

    assert.equal(sentDms.length, 0);
    assert.equal(sentChannels.length, 0);
  });

  it("should trigger alert when punching own C4 with fists", async () => {
    const { notifier, sentDms, sentChannels } = createHarness();

    await notifier.handleRaidAlert({
      ownerSteamId: "76561198000000001",
      attackerSteamId: "76561198000000001", // self-damage
      objectName: "Breaching Charge",
      weapon: "Fists",
      location: "Base Alpha",
    });

    assert.equal(sentDms.length, 1);
    assert.equal(sentChannels.length, 1);
    assert.match(sentChannels[0].payload.content, /<@123456789012345678>/);
  });

  it("should trigger alert when destroying own base structure (Pine Wall)", async () => {
    const { notifier, sentDms, sentChannels } = createHarness();

    await notifier.handleRaidAlert({
      ownerSteamId: "76561198000000001",
      attackerSteamId: "76561198000000001", // self-damage
      objectName: "Pine Wall",
      weapon: "Timberwolf",
      location: "Farmstead",
    });

    assert.equal(sentDms.length, 1);
    assert.equal(sentChannels.length, 1);
  });

  it("should personalize description with Your for builder and Bob's for teammates and channel", async () => {
    const { notifier, sentDms, sentChannels } = createHarness();

    await notifier.handleRaidAlert({
      ownerSteamId: "76561198000000001",
      ownerName: "Bob",
      eligibleSteamIds: ["76561198000000001", "76561198000000002"],
      attackerSteamId: "76561198000000099",
      attackerName: "Raider",
      objectName: "Pine Wall",
      weapon: "Timberwolf",
      location: "Farmstead",
    });

    assert.equal(sentDms.length, 2);
    // Bob's DM
    const bobDm = sentDms.find((d) => d.id === "123456789012345678");
    assert.ok(bobDm);
    assert.match(bobDm.payload.embeds[0].data.description, /^Your \*\*Pine Wall\*\*/);

    // Teammate's DM
    const teammateDm = sentDms.find((d) => d.id === "234567890123456789");
    assert.ok(teammateDm);
    assert.match(teammateDm.payload.embeds[0].data.description, /^\[Bob\]\(https:\/\/steamcommunity\.com\/profiles\/76561198000000001\)'s \*\*Pine Wall\*\*/);

    // Channel
    assert.equal(sentChannels.length, 1);
    assert.match(sentChannels[0].payload.embeds[0].data.description, /^\[Bob\]\(https:\/\/steamcommunity\.com\/profiles\/76561198000000001\)'s \*\*Pine Wall\*\*/);
  });
});
