const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { buildStatusEmbeds, buildStatusComponents, BRAND_COLOR } = require("../views");

function buildStatusCommand() {
  return new SlashCommandBuilder()
    .setName("status")
    .setDescription("View live Unturned server status and the online player list")
    .addStringOption((o) => o.setName("server").setDescription("Specific server ID"));
}

async function handleStatusInteraction(interaction, { snapshotRepo, wsServer }) {
  const targetServerId = interaction.options.getString("server");
  const sessions = wsServer ? wsServer.getActiveSessions() : [];
  const activeIds = new Set(sessions.map((s) => s.serverId));

  let snapshots;
  if (targetServerId) {
    const snap = snapshotRepo.getSnapshot(targetServerId);
    snapshots = snap ? [snap] : [];
  } else {
    snapshots = snapshotRepo.getAllSnapshots();
  }

  if (snapshots.length === 0) {
    const description = sessions.length
      ? sessions.map((s) => `• **${s.serverName || s.serverId}** (\`${s.serverId}\`) — connected, awaiting first snapshot`).join("\n")
      : "No Unturned servers are connected or have reported status yet.";
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(BRAND_COLOR).setTitle("📡 Live Status").setDescription(description)],
      ephemeral: true,
    });
  }

  return interaction.reply({ embeds: buildStatusEmbeds(snapshots, activeIds), components: buildStatusComponents(snapshots, activeIds) });
}

module.exports = { buildStatusCommand, handleStatusInteraction };
