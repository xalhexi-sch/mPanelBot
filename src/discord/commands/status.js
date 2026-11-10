const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

function buildStatusCommand() {
  return new SlashCommandBuilder()
    .setName("status")
    .setDescription("View online Unturned server status and player list")
    .addStringOption((o) => o.setName("server").setDescription("Specific server ID"));
}

async function handleStatusInteraction(interaction, { snapshotRepo, wsServer }) {
  const targetServerId = interaction.options.getString("server");

  let snapshots = [];
  if (targetServerId) {
    const snap = snapshotRepo.getSnapshot(targetServerId);
    if (snap) snapshots.push(snap);
  } else {
    snapshots = snapshotRepo.getAllSnapshots();
  }

  const activeSessions = wsServer ? wsServer.getActiveSessions() : [];
  const activeIds = new Set(activeSessions.map((s) => s.serverId));

  if (snapshots.length === 0 && activeSessions.length === 0) {
    return interaction.reply({
      content: "⚠️ No Unturned servers are currently online or reporting status.",
      ephemeral: true,
    });
  }

  // If no snapshots yet, but sessions are connected
  if (snapshots.length === 0) {
    const lines = activeSessions.map((s) => `• **${s.serverName}** (\`${s.serverId}\`) — *Connected, awaiting snapshot*`);
    return interaction.reply({
      content: `📡 **Connected Servers:**\n${lines.join("\n")}`,
      ephemeral: true,
    });
  }

  const embeds = [];
  for (const snap of snapshots) {
    const isOnline = activeIds.has(snap.serverId);
    const statusDot = isOnline ? "🟢" : "🔴";

    const embed = new EmbedBuilder()
      .setColor(isOnline ? 0x57f287 : 0xed4245)
      .setTitle(`${statusDot} ${snap.serverName || snap.serverId}`)
      .addFields(
        { name: "Server ID", value: `\`${snap.serverId}\``, inline: true },
        { name: "Map", value: snap.map || "Unknown", inline: true },
        { name: "Players", value: `${snap.onlineCount}/${snap.maxPlayers}`, inline: true }
      )
      .setTimestamp(new Date(snap.updatedAtUtc));

    if (Array.isArray(snap.players) && snap.players.length > 0) {
      const playerList = snap.players
        .slice(0, 20)
        .map((p) => {
          const name = typeof p === "string" ? p : p.playerName || p.name || "Unknown";
          const sid = typeof p === "object" && p.steamId ? ` (\`${p.steamId}\`)` : "";
          return `• ${name}${sid}`;
        })
        .join("\n");

      const more = snap.players.length > 20 ? `\n*...and ${snap.players.length - 20} more*` : "";
      embed.addFields({ name: `Online Players (${snap.players.length})`, value: playerList + more, inline: false });
    } else {
      embed.addFields({ name: "Online Players", value: "*No players online*", inline: false });
    }

    embeds.push(embed);
  }

  return interaction.reply({ embeds: embeds.slice(0, 5) });
}

module.exports = { buildStatusCommand, handleStatusInteraction };
