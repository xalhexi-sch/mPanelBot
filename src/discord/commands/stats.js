const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
  BRAND_COLOR,
  formatDuration,
  kdr,
  buildLeaderboardEmbed,
  buildSingleBoardEmbed,
  buildPlayerStatsEmbed,
  trimName,
} = require("../views");

const STEAM64 = /^\d{17}$/;

function normalizeSteam64(input) {
  const t = String(input ?? "").trim();
  const m = t.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  return m ? m[1] : t;
}

function buildStatsCommand() {
  return new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View Unturned player statistics")
    .addStringOption((o) => o.setName("steamid").setDescription("Steam64 ID (or profile URL) of the player"))
    .addUserOption((o) => o.setName("user").setDescription("Discord user with a linked account"));
}

function buildRankingCommand() {
  return new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("Display the Unturned leaderboards")
    .addStringOption((o) =>
      o
        .setName("metric")
        .setDescription("Show a single ranking instead of the full board")
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
    .addStringOption((o) => o.setName("steamid1").setDescription("Steam64 ID of player 1").setRequired(true))
    .addStringOption((o) => o.setName("steamid2").setDescription("Steam64 ID of player 2").setRequired(true));
}

async function handleStatsInteraction(interaction, { statsService, linkRepo }) {
  const steamInput = interaction.options.getString("steamid");
  const targetUser = interaction.options.getUser("user");

  let steamId;
  if (steamInput) {
    steamId = normalizeSteam64(steamInput);
    if (!STEAM64.test(steamId)) {
      return interaction.reply({ content: "❌ That is not a valid 17-digit Steam64 ID.", ephemeral: true });
    }
  } else {
    const discordId = (targetUser || interaction.user).id;
    const link = linkRepo.getLinkByDiscord(discordId);
    if (!link) {
      return interaction.reply({
        content: targetUser
          ? `❌ <@${discordId}> has not linked a Steam account.`
          : "❌ You have not linked your Steam account. Pass a `steamid` or use `/link` first.",
        ephemeral: true,
      });
    }
    steamId = link.steam_id;
  }

  await interaction.deferReply();
  const stats = await statsService.getStats(steamId);
  if (!stats) return interaction.editReply({ content: `⚠️ No recorded statistics for \`${steamId}\` yet.` });
  return interaction.editReply({ embeds: [buildPlayerStatsEmbed(stats)] });
}

async function handleRankingInteraction(interaction, { statsService }) {
  const metric = interaction.options.getString("metric");
  await interaction.deferReply();

  if (metric) {
    const rows = await statsService.getTop(metric, 10);
    return interaction.editReply({ embeds: [buildSingleBoardEmbed(metric, rows)] });
  }
  const boards = await statsService.getLeaderboards(10);
  if (!boards.kills.length && !boards.playtime.length) {
    return interaction.editReply({ content: "No player statistics have been collected yet." });
  }
  return interaction.editReply({ embeds: [buildLeaderboardEmbed(boards, { iconURL: interaction.client.user?.displayAvatarURL?.() })] });
}

async function handleCompareInteraction(interaction, { statsService }) {
  const a = normalizeSteam64(interaction.options.getString("steamid1", true));
  const b = normalizeSteam64(interaction.options.getString("steamid2", true));
  if (!STEAM64.test(a) || !STEAM64.test(b)) {
    return interaction.reply({ content: "❌ Both values must be valid 17-digit Steam64 IDs.", ephemeral: true });
  }

  await interaction.deferReply();
  const [ra, rb] = await Promise.all([statsService.getStats(a), statsService.getStats(b)]);
  if (!ra || !rb) {
    return interaction.editReply({
      content: `Compare failed:\n• A: \`${a}\` ${ra ? "✅" : "❌ not found"}\n• B: \`${b}\` ${rb ? "✅" : "❌ not found"}`,
    });
  }

  const col = (s, o) => {
    const win = (x, y, higherBetter = true) => (x === y ? "" : (x > y) === higherBetter ? " 🏆" : "");
    return (
      `⚔️ Kills: **${s.kills}**${win(s.kills, o.kills)}\n` +
      `💀 Deaths: **${s.deaths}**${win(s.deaths, o.deaths, false)}\n` +
      `📈 KDR: **${kdr(s.kills, s.deaths)}**${win(+kdr(s.kills, s.deaths), +kdr(o.kills, o.deaths))}\n` +
      `🎯 Headshots: **${s.headshots}**${win(s.headshots, o.headshots)}\n` +
      `⏳ Playtime: **${formatDuration(s.playtimeSeconds)}**${win(s.playtimeSeconds, o.playtimeSeconds)}`
    );
  };

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle("⚔️ Player Comparison")
    .addFields(
      { name: trimName(ra.playerName, 24), value: col(ra, rb), inline: true },
      { name: trimName(rb.playerName, 24), value: col(rb, ra), inline: true }
    )
    .setFooter({ text: "mPanel Player Stats" })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

module.exports = {
  buildStatsCommand,
  buildRankingCommand,
  buildCompareCommand,
  handleStatsInteraction,
  handleRankingInteraction,
  handleCompareInteraction,
};
