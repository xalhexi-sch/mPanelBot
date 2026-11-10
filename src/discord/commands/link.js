const { SlashCommandBuilder } = require("discord.js");

function buildLinkCommand() {
  return new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Steam account using the code generated in-game via /link")
    .addStringOption((o) =>
      o.setName("code").setDescription("The 6-character code from in-game /link").setRequired(true)
    );
}

function buildUnlinkCommand() {
  return new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Steam account from Discord");
}

async function handleLinkInteraction(interaction, { linkService }) {
  const code = interaction.options.getString("code", true);

  await interaction.deferReply({ ephemeral: true });

  const result = await linkService.redeemCode({
    code,
    discordId: interaction.user.id,
    guild: interaction.guild,
  });

  if (!result.success) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  return interaction.editReply({
    content: `✅ Successfully linked your Steam account!\n` +
      `• Player: **${result.playerName}**\n` +
      `• SteamID64: \`${result.steamId}\`\n` +
      `• Steam Profile: https://steamcommunity.com/profiles/${result.steamId}`,
  });
}

async function handleUnlinkInteraction(interaction, { linkService, roleSyncManager }) {
  await interaction.deferReply({ ephemeral: true });

  const unlinked = linkService.unlink({ discordId: interaction.user.id });
  if (!unlinked) {
    return interaction.editReply({ content: "⚠️ You do not have a linked Steam account." });
  }

  if (interaction.member && roleSyncManager) {
    try {
      await roleSyncManager.syncMember(interaction.member);
    } catch {}
  }

  return interaction.editReply({ content: "✅ Your Steam account has been unlinked from Discord." });
}

module.exports = {
  buildLinkCommand,
  buildUnlinkCommand,
  handleLinkInteraction,
  handleUnlinkInteraction,
};
