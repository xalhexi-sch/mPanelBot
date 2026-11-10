const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

function formatPlaytime(seconds) {
  const s = Math.max(0, parseInt(seconds, 10) || 0);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function buildStatsCommand() {
  return new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View Unturned player statistics")
    .addStringOption((o) =>
      o.setName("steamid").setDescription("Steam64 ID of the player")
    )
    .addUserOption((o) =>
      o.setName("user").setDescription("Discord user with a linked account")
    );
}

function buildRankingCommand() {
  return new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("Display Unturned server leaderboards")
    .addStringOption((o) =>
      o
        .setName("metric")
        .setDescription("Ranking metric (default: kills)")
        .addChoices(
          { name: "Kills", value: "kills" },
          { name: "Playtime", value: "playtime" },
          { name: "Deaths", value: "deaths" }
        )
    );
}

function buildCompareCommand() {
  return new SlashCommandBuilder()
    .setName("compare")
    .setDescription("Compare statistics of two players side-by-side")
    .addStringOption((o) =>
      o.setName("steamid1").setDescription("Steam64 ID of player 1").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("steamid2").setDescription("Steam64 ID of player 2").setRequired(true)
    );
}

async function handleStatsInteraction(interaction, { statsRepo, linkRepo }) {
  const steamInput = interaction.options.getString("steamid");
  const targetUser = interaction.options.getUser("user");

  let steamId = null;

  if (steamInput) {
    steamId = steamInput.trim();
  } else if (targetUser) {
    const link = linkRepo.getLinkByDiscord(targetUser.id);
    if (!link) {
      return interaction.reply({
        content: `❌ User <@${targetUser.id}> does not have a linked Steam account.`,
        ephemeral: true,
      });
    }
    steamId = link.steam_id;
  } else {
    // Default to invoking user
    const link = linkRepo.getLinkByDiscord(interaction.user.id);
    if (!link) {
      return interaction.reply({
        content: "❌ You have not linked your Steam account. Specify a `steamid` or use `/link` first.",
        ephemeral: true,
      });
    }
    steamId = link.steam_id;
  }

  const stats = statsRepo.getStats(steamId);
  if (!stats) {
    return interaction.reply({
      content: `⚠️ No recorded statistics found for SteamID \`${steamId}\`.`,
      ephemeral: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0xd41111)
    .setTitle(`📊 Player Statistics: ${stats.playerName}`)
    .setURL(`https://steamcommunity.com/profiles/${stats.steamId}`)
    .addFields(
      { name: "Kills", value: `${stats.kills}`, inline: true },
      { name: "Deaths", value: `${stats.deaths}`, inline: true },
      { name: "K/D Ratio", value: `${stats.kd}`, inline: true },
      { name: "Headshots", value: `${stats.headshots}`, inline: true },
      { name: "Playtime", value: formatPlaytime(stats.playtimeSeconds), inline: true },
      { name: "Steam64", value: `\`${stats.steamId}\``, inline: true }
    )
    .setFooter({ text: "mPanel In-Game Statistics" })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

async function handleRankingInteraction(interaction, { statsRepo }) {
  const metric = interaction.options.getString("metric") || "kills";

  let rows = [];
  let title = "";
  if (metric === "playtime") {
    rows = statsRepo.getTopPlaytime(10);
    title = "🏆 Top 10 Leaderboard: Playtime";
  } else if (metric === "deaths") {
    rows = statsRepo.getTopDeaths(10);
    title = "💀 Top 10 Leaderboard: Deaths";
  } else {
    rows = statsRepo.getTopKills(10);
    title = "⚔️ Top 10 Leaderboard: Kills";
  }

  if (rows.length === 0) {
    return interaction.reply({ content: "No player statistics have been collected yet.", ephemeral: true });
  }

  const medalEmojis = ["🥇", "🥈", "🥉"];
  const lines = rows.map((r, i) => {
    const medal = medalEmojis[i] || `**${i + 1}.**`;
    const name = r.player_name || "Unknown";
    const profile = `[${name}](https://steamcommunity.com/profiles/${r.steam_id})`;

    let val = "";
    if (metric === "playtime") val = `${formatPlaytime(r.playtime_seconds)}`;
    else if (metric === "deaths") val = `${r.deaths} deaths`;
    else val = `${r.kills} kills`;

    return `${medal} ${profile} — **${val}**`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xd41111)
    .setTitle(title)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

async function handleCompareInteraction(interaction, { statsRepo }) {
  const sid1 = interaction.options.getString("steamid1", true).trim();
  const sid2 = interaction.options.getString("steamid2", true).trim();

  const stats1 = statsRepo.getStats(sid1);
  const stats2 = statsRepo.getStats(sid2);

  if (!stats1 && !stats2) {
    return interaction.reply({ content: "Neither player has recorded statistics.", ephemeral: true });
  }

  const p1 = stats1 || { playerName: sid1, kills: 0, deaths: 0, kd: 0, headshots: 0, playtimeSeconds: 0 };
  const p2 = stats2 || { playerName: sid2, kills: 0, deaths: 0, kd: 0, headshots: 0, playtimeSeconds: 0 };

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`⚔️ Player Comparison: ${p1.playerName} vs ${p2.playerName}`)
    .addFields(
      {
        name: `${p1.playerName}`,
        value:
          `• Kills: **${p1.kills}**\n` +
          `• Deaths: **${p1.deaths}**\n` +
          `• K/D: **${p1.kd}**\n` +
          `• Headshots: **${p1.headshots}**\n` +
          `• Playtime: **${formatPlaytime(p1.playtimeSeconds)}**`,
        inline: true,
      },
      {
        name: `${p2.playerName}`,
        value:
          `• Kills: **${p2.kills}**\n` +
          `• Deaths: **${p2.deaths}**\n` +
          `• K/D: **${p2.kd}**\n` +
          `• Headshots: **${p2.headshots}**\n` +
          `• Playtime: **${formatPlaytime(p2.playtimeSeconds)}**`,
        inline: true,
      }
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

module.exports = {
  buildStatsCommand,
  buildRankingCommand,
  buildCompareCommand,
  handleStatsInteraction,
  handleRankingInteraction,
  handleCompareInteraction,
};
