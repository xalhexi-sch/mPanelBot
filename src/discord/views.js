/**
 * Embed builders shared by slash commands and the auto-updating panels.
 * Pure functions (no Discord I/O) so they are cheap to unit test.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const BRAND_COLOR = 0xd41111;
const OFFLINE_COLOR = 0x4f545c;
const ZWS = "​";
const MEDALS = ["🥇", "🥈", "🥉"];

const steamProfile = (id) => `https://steamcommunity.com/profiles/${id || ""}`;
const rankEmoji = (i) => MEDALS[i] || `\`${String(i + 1).padStart(2, "0")}\``;

function trimName(value, max = 16) {
  const text = String(value ?? "").replace(/[\[\]()*_`~|>]/g, "").trim() || "Unknown";
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function formatDuration(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Full-precision duration like the old board: 11d 17h 48m 2s */
function formatLong(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return `${d ? d + "d " : ""}${h ? h + "h " : ""}${m ? m + "m " : ""}${s}s`;
}

function kdr(kills, deaths) {
  const k = Number(kills) || 0;
  const d = Number(deaths) || 0;
  if (!d) return k.toFixed(2);
  return (k / d).toFixed(2);
}

const nameLink = (name, steamId, max) => `[${trimName(name, max)}](${steamProfile(steamId)})`;

/** One embed for a single game server. `online=false` renders the greyed-out offline state. */
function buildServerStatusEmbed(snap, { online = true, page = 0, perPage = 9 } = {}) {
  const players = Array.isArray(snap.players) ? [...snap.players] : [];
  players.sort((a, b) => (Number(b.sessionDurationSeconds) || 0) - (Number(a.sessionDurationSeconds) || 0));

  const count = Number(snap.onlineCount ?? snap.onlinePlayers ?? players.length) || 0;
  const pages = perPage > 0 ? Math.max(1, Math.ceil(players.length / perPage)) : 1;
  const cur = ((page % pages) + pages) % pages;
  const slice = perPage > 0 ? players.slice(cur * perPage, cur * perPage + perPage) : [];

  const embed = new EmbedBuilder()
    .setColor(online ? BRAND_COLOR : OFFLINE_COLOR)
    .setTitle(String(snap.serverName || snap.serverId));

  if (!online) {
    const ts = snap.updatedAtUtc ? Math.floor(new Date(snap.updatedAtUtc).getTime() / 1000) : null;
    embed.setDescription(`> **Offline**${ts ? ` ◾️ last seen <t:${ts}:R>` : ""}`);
    return embed;
  }

  embed.setDescription(`> **${[snap.serverSteamId, snap.map || "Unknown map"].filter(Boolean).join(" ◾️ ")} ◾️ 👥 ${count}/${snap.maxPlayers || 0}**`);

  if (slice.length) {
    for (const p of slice) {
      const ping = p.pingMs != null ? `${p.pingMs}ms` : "?ms";
      embed.addFields({
        name: ZWS,
        value:
          `> 👤 **${nameLink(p.characterName || p.playerName, p.steamId, 14)}**\n` +
          `> ⏳ **${formatDuration(p.sessionDurationSeconds)}**\n> 📶 **${ping}**`,
        inline: true,
      });
    }
    for (let i = 0; i < (3 - (slice.length % 3)) % 3; i++) embed.addFields({ name: ZWS, value: ZWS, inline: true });
  } else {
    embed.addFields({
      name: "Players",
      value: count > 0 ? `_${count} player(s) online — details unavailable._` : "_No players online._",
    });
  }

  if (pages > 1) embed.setFooter({ text: `Page ${cur + 1}/${pages}` });
  embed
    .setTimestamp(snap.updatedAtUtc ? new Date(snap.updatedAtUtc) : new Date());
  return embed;
}

/** Total characters Discord counts towards the 6000-per-message embed limit. */
function embedLength(e) {
  const j = typeof e.toJSON === "function" ? e.toJSON() : e;
  let n = (j.title || "").length + (j.description || "").length + (j.footer?.text || "").length + (j.author?.name || "").length;
  for (const f of j.fields || []) n += (f.name || "").length + (f.value || "").length;
  return n;
}

/** Old status "Play" link buttons (one per server that reports its server code). Max 5 per row, 1 row here. */
function buildStatusComponents(snapshots, activeIds) {
  const buttons = snapshots
    .filter((s) => s.serverSteamId && activeIds.has(s.serverId))
    .slice(0, 5)
    .map((s, _i, all) =>
      new ButtonBuilder()
        .setLabel(all.length > 1 ? `Play ${String(s.serverName || s.serverId).slice(0, 30)}` : "Play")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://join.unbeaten.gg/${s.serverSteamId}`)
    );
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

const MESSAGE_EMBED_BUDGET = 5600; // safety margin under Discord's 6000

/** All servers, online first. Player grids shrink as servers are added so one message always fits Discord's limits. */
function buildStatusEmbeds(snapshots, activeIds, { page = 0 } = {}) {
  if (!snapshots.length) {
    return [
      new EmbedBuilder().setColor(OFFLINE_COLOR).setTitle("📡 Live Status").setDescription("_No servers have reported yet._"),
    ];
  }
  const sorted = [...snapshots]
    .sort((a, b) => Number(activeIds.has(b.serverId)) - Number(activeIds.has(a.serverId)))
    .slice(0, 10);

  let embeds = [];
  for (const perPage of [9, 6, 3, 0]) {
    embeds = sorted.map((s) => buildServerStatusEmbed(s, { online: activeIds.has(s.serverId), page, perPage }));
    if (embeds.reduce((n, e) => n + embedLength(e), 0) <= MESSAGE_EMBED_BUDGET) break;
  }
  return embeds;
}

const BOARD_SIZE = 5; // 3 headers + 3 x 5 rows = 18 fields (Discord max 25)
const rankMedal = (i) => MEDALS[i] || "🏅";

/**
 * Old Blood Horizon leaderboard layout: underlined column headers, then one 3-wide row per rank.
 * `iconURL` is the bot avatar shown in the author line.
 */
function buildLeaderboardEmbed({ kills, playtime, deaths }, { iconURL = null, title = "Blood Horizon Leaderboard" } = {}) {
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor(iconURL ? { name: title, iconURL } : { name: title })
    .addFields(
      { name: "__Most Kills__", value: ZWS, inline: true },
      { name: "__Most Play Time__", value: ZWS, inline: true },
      { name: "__Most Deaths__", value: ZWS, inline: true }
    );

  const cell = (r, i, valueText) =>
    r ? `> ${rankMedal(i)} **${nameLink(r.player_name, r.steam_id, 14)}**
> ${valueText(r)}` : `> ${rankMedal(i)} **—**
> _no data_`;

  for (let i = 0; i < BOARD_SIZE; i++) {
    embed.addFields(
      { name: ZWS, value: cell(kills[i], i, (r) => `**${r.kills}** Kills`), inline: true },
      { name: ZWS, value: cell(playtime[i], i, (r) => `**${formatLong(r.playtime_seconds)}**`), inline: true },
      { name: ZWS, value: cell(deaths[i], i, (r) => `**${r.deaths}** Deaths`), inline: true }
    );
  }
  return embed.setTimestamp();
}

/** Old /farmbots layout: three columns (farmers / builders / gatherers), one row per rank. */
function buildFarmbotsEmbed({ farmers, builders, gatherers }) {
  const e = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("🤖 FarmBots — Server Activity Rankings")
    .setDescription("Top farmers (Zombies + MegaZombies), top builders (Structures + Barricades), and top gatherers (Resources).")
    .addFields(
      { name: "__Top Farmers__", value: ZWS, inline: true },
      { name: "__Top Builders__", value: ZWS, inline: true },
      { name: "__Top Gatherers__", value: ZWS, inline: true }
    );
  const head = (r, i) => `> ${rankMedal(i)} **${nameLink(r.name, r.steamId, 14)}**`;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const f = farmers[i], b = builders[i], g = gatherers[i];
    e.addFields(
      { name: ZWS, value: f ? `${head(f, i)}
> **${f.zombies}** Zombies • **${f.mega}** Mega • **${+f.zombies + +f.mega}** Total` : `> ${rankMedal(i)} **—**`, inline: true },
      { name: ZWS, value: b ? `${head(b, i)}
> **${b.structures}** Structures • **${b.barricades}** Barricades • **${+b.structures + +b.barricades}** Total` : `> ${rankMedal(i)} **—**`, inline: true },
      { name: ZWS, value: g ? `${head(g, i)}
> **${g.resources}** Resources` : `> ${rankMedal(i)} **—**`, inline: true }
    );
  }
  return e.setTimestamp();
}

function buildSingleBoardEmbed(metric, rows) {
  const meta =
    {
      kills: ["⚔️ Top 10 — Kills", (r) => `**${r.kills}** kills`],
      playtime: ["⏳ Top 10 — Play Time", (r) => `**${formatDuration(r.playtime_seconds)}**`],
      deaths: ["💀 Top 10 — Deaths", (r) => `**${r.deaths}** deaths`],
    }[metric] || ["⚔️ Top 10 — Kills", (r) => `**${r.kills}** kills`];
  const lines = rows.length
    ? rows.map((r, i) => `${rankEmoji(i)} ${nameLink(r.player_name, r.steam_id, 24)} — ${meta[1](r)}`).join("\n")
    : "_No data yet_";
  return new EmbedBuilder().setColor(BRAND_COLOR).setTitle(meta[0]).setDescription(lines).setTimestamp();
}

function buildPlayerStatsEmbed(s) {
  const hsPct = s.kills > 0 ? ((s.headshots / s.kills) * 100).toFixed(1) : "0.0";
  const rank = s.rank && s.total ? `\n🏆 Rank (Kills): **#${s.rank}** / **${s.total}**` : "";
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: "Player Stats" })
    .setDescription(`🏅 **${nameLink(s.playerName, s.steamId, 32)}**\nSteam64: \`${s.steamId}\`${rank}`)
    .addFields(
      { name: "Kills", value: `**${s.kills}**`, inline: true },
      { name: "Deaths", value: `**${s.deaths}**`, inline: true },
      { name: "KDR", value: `**${kdr(s.kills, s.deaths)}**`, inline: true },
      { name: "Headshots", value: `**${s.headshots}**`, inline: true },
      { name: "Playtime", value: `**${formatDuration(s.playtimeSeconds)}**`, inline: true },
      { name: "HS%", value: `**${hsPct}%**`, inline: true }
    )
    .setFooter({ text: "Click the name to open the Steam profile" })
    .setTimestamp();
}

module.exports = {
  BRAND_COLOR,
  ZWS,
  trimName,
  formatDuration,
  formatLong,
  kdr,
  buildServerStatusEmbed,
  buildStatusEmbeds,
  buildStatusComponents,
  embedLength,
  MESSAGE_EMBED_BUDGET,
  buildLeaderboardEmbed,
  buildSingleBoardEmbed,
  buildFarmbotsEmbed,
  buildPlayerStatsEmbed,
};
