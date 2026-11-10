/**
 * Embed builders shared by slash commands and the auto-updating panels.
 * Pure functions (no Discord I/O) so they are cheap to unit test.
 */
const { EmbedBuilder } = require("discord.js");

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
  const pages = Math.max(1, Math.ceil(players.length / perPage));
  const cur = ((page % pages) + pages) % pages;
  const slice = players.slice(cur * perPage, cur * perPage + perPage);

  const embed = new EmbedBuilder()
    .setColor(online ? BRAND_COLOR : OFFLINE_COLOR)
    .setTitle(`${online ? "🟢" : "🔴"} ${snap.serverName || snap.serverId}`);

  if (!online) {
    const ts = snap.updatedAtUtc ? Math.floor(new Date(snap.updatedAtUtc).getTime() / 1000) : null;
    embed.setDescription(`> **Offline**${ts ? ` ◾️ last seen <t:${ts}:R>` : ""}`);
    return embed;
  }

  embed.setDescription(`> **${snap.map || "Unknown map"} ◾️ 👥 ${count}/${snap.maxPlayers || 0} ◾️ \`${snap.serverId}\`**`);

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

  embed
    .setFooter({ text: pages > 1 ? `Page ${cur + 1}/${pages} • mPanel` : "mPanel Live Status" })
    .setTimestamp(snap.updatedAtUtc ? new Date(snap.updatedAtUtc) : new Date());
  return embed;
}

/** All servers, online first. Discord allows 10 embeds per message. */
function buildStatusEmbeds(snapshots, activeIds, { page = 0 } = {}) {
  if (!snapshots.length) {
    return [
      new EmbedBuilder().setColor(OFFLINE_COLOR).setTitle("📡 Live Status").setDescription("_No servers have reported yet._"),
    ];
  }
  const sorted = [...snapshots].sort((a, b) => Number(activeIds.has(b.serverId)) - Number(activeIds.has(a.serverId)));
  return sorted.slice(0, 10).map((s) => buildServerStatusEmbed(s, { online: activeIds.has(s.serverId), page }));
}

function boardColumn(rows, valueFn) {
  if (!rows.length) return "_No data yet_";
  return rows
    .map((r, i) => `${rankEmoji(i)} ${nameLink(r.player_name, r.steam_id, 15)}\n┗ ${valueFn(r)}`)
    .join("\n")
    .slice(0, 1024);
}

/** Three-column leaderboard (Kills / Playtime / Deaths). */
function buildLeaderboardEmbed({ kills, playtime, deaths }, { source = "sqlite" } = {}) {
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("🏆 Leaderboards")
    .addFields(
      { name: "⚔️ Most Kills", value: boardColumn(kills, (r) => `**${r.kills}** kills`), inline: true },
      { name: "⏳ Most Play Time", value: boardColumn(playtime, (r) => `**${formatDuration(r.playtime_seconds)}**`), inline: true },
      { name: "💀 Most Deaths", value: boardColumn(deaths, (r) => `**${r.deaths}** deaths`), inline: true }
    )
    .setFooter({ text: `mPanel Leaderboards${source === "mysql" ? " • MySQL" : ""}` })
    .setTimestamp();
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
    .setAuthor({ name: "mPanel — Player Stats" })
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
  kdr,
  buildServerStatusEmbed,
  buildStatusEmbeds,
  buildLeaderboardEmbed,
  buildSingleBoardEmbed,
  buildPlayerStatsEmbed,
};
