const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

function isAuthorizedAdmin(interaction, guildRepo) {
  if (!interaction.member) return false;
  if (interaction.member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const cfg = guildRepo.getGuildConfig(interaction.guildId);
  const adminRoleIds = cfg?.adminRoleIds || [];
  if (adminRoleIds.length === 0) return false;

  return interaction.member.roles?.cache?.some((r) => adminRoleIds.includes(r.id));
}

function buildBanCommand() {
  return new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a player from the Unturned server by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason for ban"))
    .addStringOption((o) => o.setName("duration").setDescription("Duration (e.g. 1d, 2h, 30m)"))
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

function buildMuteCommand() {
  return new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute a player on the Unturned server by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason for mute"))
    .addStringOption((o) => o.setName("duration").setDescription("Duration (e.g. 1h, 10m)"))
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

function buildWarnCommand() {
  return new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Issue a formal warning to a player by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason for warning").setRequired(true))
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

function buildKickCommand() {
  return new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a player from the Unturned server by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason for kick"))
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

function buildUnbanCommand() {
  return new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a player by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

function buildUnmuteCommand() {
  return new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute a player by Steam64")
    .addStringOption((o) =>
      o.setName("steam64id").setDescription("17-digit Steam64 ID").setRequired(true)
    )
    .addStringOption((o) => o.setName("server").setDescription("Target server ID"));
}

async function handleModerationInteraction(interaction, { moderationService, guildRepo }) {
  if (!isAuthorizedAdmin(interaction, guildRepo)) {
    return interaction.reply({
      content: "❌ You do not have permission to execute moderation commands.",
      ephemeral: true,
    });
  }

  const action = interaction.commandName;
  const steam64 = interaction.options.getString("steam64id", true);
  const reason = interaction.options.getString("reason");
  const duration = interaction.options.getString("duration");
  const serverId = interaction.options.getString("server");

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await moderationService.executeModeration({
      action,
      steam64,
      reason,
      duration,
      serverId,
      requestedByDiscordId: interaction.user.id,
      requestedByTag: interaction.user.tag || interaction.user.username,
    });

    return interaction.editReply({
      content:
        `✅ Moderation action \`${action.toUpperCase()}\` executed!\n` +
        `• Target: \`${steam64}\`\n` +
        `• Target Server: \`${result.serverId}\` (${result.executedVia})\n` +
        `• Result: ${result.message}`,
    });
  } catch (err) {
    return interaction.editReply({
      content: `❌ Failed to execute \`${action}\` on \`${steam64}\`: ${err.message}`,
    });
  }
}

module.exports = {
  isAuthorizedAdmin,
  buildBanCommand,
  buildMuteCommand,
  buildWarnCommand,
  buildKickCommand,
  buildUnbanCommand,
  buildUnmuteCommand,
  handleModerationInteraction,
};
