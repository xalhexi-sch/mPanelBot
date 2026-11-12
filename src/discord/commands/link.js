const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const {
  buildLinkPanelEmbed,
  buildLinkPanelComponents,
  buildLinkSuccessEmbed,
  buildLinkErrorEmbed,
  LINK_MODAL_ID,
} = require("../views");

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

async function redeemAndReply(interaction, code, linkService) {
  await interaction.deferReply({ ephemeral: true });
  const result = await linkService.redeemCode({ code, discordId: interaction.user.id, guild: interaction.guild });
  if (!result.success) return interaction.editReply({ embeds: [buildLinkErrorEmbed(result.error)] });
  return interaction.editReply({ embeds: [buildLinkSuccessEmbed(result)] });
}

async function handleLinkInteraction(interaction, { linkService }) {
  return redeemAndReply(interaction, interaction.options.getString("code", true), linkService);
}

/** Submit of the modal opened from the link panel button. */
async function handleLinkModal(interaction, { linkService }) {
  return redeemAndReply(interaction, interaction.fields.getTextInputValue("code"), linkService);
}

/** Button on the link panel -> modal asking for the in-game code. */
async function handleLinkButton(interaction) {
  const modal = new ModalBuilder().setCustomId(LINK_MODAL_ID).setTitle("Link Steam Account").addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("code")
        .setLabel("Enter your 6-character code")
        .setPlaceholder("Paste the code you got from /link in-game")
        .setStyle(TextInputStyle.Short)
        .setMinLength(6)
        .setMaxLength(6)
        .setRequired(true)
    )
  );
  return interaction.showModal(modal);
}

/** Posts the link panel in `channel`, or edits the previously posted one in place. Returns the message. */
async function postOrRefreshLinkPanel(channel, guildRepo, guildId) {
  const payload = { embeds: [buildLinkPanelEmbed()], components: buildLinkPanelComponents() };
  const cfg = guildRepo.getGuildConfig(guildId) || {};
  if (cfg.linkChannelId === channel.id && cfg.linkMessageId) {
    try {
      const existing = await channel.messages.fetch(cfg.linkMessageId);
      return await existing.edit(payload);
    } catch {
      // message was deleted: fall through and post a fresh one
    }
  }
  const msg = await channel.send(payload);
  guildRepo.upsertGuildConfig(guildId, { linkChannelId: channel.id, linkMessageId: msg.id });
  return msg;
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
  postOrRefreshLinkPanel,
  handleLinkButton,
  handleLinkModal,
};
