const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");

function buildSetupCommand() {
  return new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure mPanel channels, roles, and settings for this guild")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("channels")
        .setDescription("Set channels for logs, raid alerts, and chat relay")
        .addChannelOption((o) =>
          o.setName("raid_channel").setDescription("Channel for raid alerts").addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o.setName("chat_channel").setDescription("Channel for 2-way chat relay").addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o.setName("join_leave_channel").setDescription("Channel for connect/disconnect logs").addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o.setName("command_log_channel").setDescription("Channel for player command logs").addChannelTypes(ChannelType.GuildText)
        )
        .addChannelOption((o) =>
          o.setName("punishment_log_channel").setDescription("Channel for moderation punishment logs").addChannelTypes(ChannelType.GuildText)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("roles")
        .setDescription("Set linked role and admin roles")
        .addRoleOption((o) =>
          o.setName("linked_role").setDescription("Role awarded to players who link their Steam account")
        )
        .addRoleOption((o) =>
          o.setName("admin_role").setDescription("Additional role permitted to run mPanel moderation commands")
        )
    )
    .addSubcommand((sub) =>
      sub.setName("show").setDescription("Display current guild mPanel configuration")
    );
}

async function handleSetupInteraction(interaction, { guildRepo }) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Setup commands must be run inside a guild.", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === "channels") {
    const raidCh = interaction.options.getChannel("raid_channel");
    const chatCh = interaction.options.getChannel("chat_channel");
    const joinLeaveCh = interaction.options.getChannel("join_leave_channel");
    const cmdLogCh = interaction.options.getChannel("command_log_channel");
    const punLogCh = interaction.options.getChannel("punishment_log_channel");

    const updates = {};
    if (raidCh) updates.raidChannelId = raidCh.id;
    if (chatCh) updates.chatChannelId = chatCh.id;
    if (joinLeaveCh) updates.joinLeaveChannelId = joinLeaveCh.id;
    if (cmdLogCh) updates.commandLogChannelId = cmdLogCh.id;
    if (punLogCh) updates.punishmentLogChannelId = punLogCh.id;

    if (Object.keys(updates).length === 0) {
      return interaction.reply({ content: "⚠️ No channel options were specified to update.", ephemeral: true });
    }

    const saved = guildRepo.upsertGuildConfig(guildId, updates);
    return interaction.reply({
      content: `✅ Guild channels updated successfully!\n` +
        `• Raid Channel: ${saved.raidChannelId ? `<#${saved.raidChannelId}>` : "*Not set*"}\n` +
        `• Chat Channel: ${saved.chatChannelId ? `<#${saved.chatChannelId}>` : "*Not set*"}\n` +
        `• Join/Leave Channel: ${saved.joinLeaveChannelId ? `<#${saved.joinLeaveChannelId}>` : "*Not set*"}\n` +
        `• Command Log Channel: ${saved.commandLogChannelId ? `<#${saved.commandLogChannelId}>` : "*Not set*"}\n` +
        `• Punishment Log Channel: ${saved.punishmentLogChannelId ? `<#${saved.punishmentLogChannelId}>` : "*Not set*"}`,
      ephemeral: true,
    });
  }

  if (sub === "roles") {
    const linkedRole = interaction.options.getRole("linked_role");
    const adminRole = interaction.options.getRole("admin_role");

    const existing = guildRepo.getGuildConfig(guildId) || {};
    const updates = {};

    if (linkedRole) updates.linkedRoleId = linkedRole.id;
    if (adminRole) {
      const existingAdmins = new Set(existing.adminRoleIds || []);
      existingAdmins.add(adminRole.id);
      updates.adminRoleIds = Array.from(existingAdmins);
    }

    if (Object.keys(updates).length === 0) {
      return interaction.reply({ content: "⚠️ No role options were specified to update.", ephemeral: true });
    }

    const saved = guildRepo.upsertGuildConfig(guildId, updates);
    return interaction.reply({
      content: `✅ Guild roles updated successfully!\n` +
        `• Linked Role: ${saved.linkedRoleId ? `<@&${saved.linkedRoleId}>` : "*Not set*"}\n` +
        `• Admin Roles: ${saved.adminRoleIds?.length ? saved.adminRoleIds.map((r) => `<@&${r}>`).join(", ") : "*None*"}`,
      ephemeral: true,
    });
  }

  if (sub === "show") {
    const cfg = guildRepo.getGuildConfig(guildId);
    if (!cfg) {
      return interaction.reply({ content: "No configuration has been set for this guild yet. Use `/setup channels` or `/setup roles`.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`⚙️ mPanel Guild Configuration (${interaction.guild.name})`)
      .addFields(
        { name: "Raid Channel", value: cfg.raidChannelId ? `<#${cfg.raidChannelId}>` : "*Not configured*", inline: true },
        { name: "Chat Relay Channel", value: cfg.chatChannelId ? `<#${cfg.chatChannelId}>` : "*Not configured*", inline: true },
        { name: "Join/Leave Logs", value: cfg.joinLeaveChannelId ? `<#${cfg.joinLeaveChannelId}>` : "*Not configured*", inline: true },
        { name: "Command Logs", value: cfg.commandLogChannelId ? `<#${cfg.commandLogChannelId}>` : "*Not configured*", inline: true },
        { name: "Punishment Logs", value: cfg.punishmentLogChannelId ? `<#${cfg.punishmentLogChannelId}>` : "*Not configured*", inline: true },
        { name: "Linked Role", value: cfg.linkedRoleId ? `<@&${cfg.linkedRoleId}>` : "*Not configured*", inline: true },
        { name: "Admin Roles", value: cfg.adminRoleIds?.length ? cfg.adminRoleIds.map((r) => `<@&${r}>`).join(", ") : "*Default (Admins only)*", inline: false }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { buildSetupCommand, handleSetupInteraction };
