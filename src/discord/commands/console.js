const { SlashCommandBuilder } = require("discord.js");
const { isAuthorizedAdmin, adminOnly } = require("./moderation");

function buildConsoleCommand() {
  return adminOnly(new SlashCommandBuilder())
    .setName("run")
    .setDescription("Execute an approved in-game/Rocket console command")
    .addStringOption((o) =>
      o.setName("command").setDescription("Raw console command (e.g. broadcast Hello)").setRequired(true)
    )
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

async function handleConsoleInteraction(interaction, { moderationService, guildRepo }) {
  if (!isAuthorizedAdmin(interaction, guildRepo)) {
    return interaction.reply({
      content: "❌ You do not have permission to execute console commands.",
      ephemeral: true,
    });
  }

  const rawCommand = interaction.options.getString("command", true);
  const serverId = interaction.options.getString("server");

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await moderationService.executeConsoleCommand({
      rawCommand,
      serverId,
      requestedByDiscordId: interaction.user.id,
      requestedByTag: interaction.user.tag || interaction.user.username,
    });

    return interaction.editReply({
      content:
        `✅ Console command sent to \`${result.serverId}\` (${result.executedVia}):\n` +
        `\`\`\`\n${result.fullCommand}\n\`\`\`\n` +
        `**Result:** ${result.message}`,
    });
  } catch (err) {
    return interaction.editReply({
      content: `❌ Command rejected or failed: ${err.message}`,
    });
  }
}

module.exports = { buildConsoleCommand, handleConsoleInteraction };
