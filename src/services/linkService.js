class LinkService {
  constructor({ linkRepo, onLinkCompleted = null }) {
    this.linkRepo = linkRepo;
    this.onLinkCompleted = onLinkCompleted;
  }

  handleLinkRequestedEvent({ code, steamId, playerName, serverId, ttlSeconds = 600 }) {
    if (!code || !steamId) {
      throw new Error("Missing code or steamId in link request.");
    }
    return this.linkRepo.storeCode(String(code).trim().toUpperCase(), steamId, playerName, serverId, ttlSeconds);
  }

  async redeemCode({ code, discordId, guild = null }) {
    const cleanCode = String(code || "").trim().toUpperCase();
    const cleanDiscordId = String(discordId || "").trim();

    if (!cleanCode) {
      return { success: false, error: "Please provide a valid link code." };
    }

    // Check if Discord user is already linked
    const existingLink = this.linkRepo.getLinkByDiscord(cleanDiscordId);
    if (existingLink) {
      return {
        success: false,
        error: `Your Discord account is already linked to SteamID: \`${existingLink.steam_id}\`. Use \`/unlink\` first if you wish to link another account.`,
      };
    }

    // Consume code (atomic transaction, check expiration)
    const codeRecord = this.linkRepo.consumeCode(cleanCode);
    if (!codeRecord) {
      return {
        success: false,
        error: "Invalid or expired link code. Please generate a new code in-game with `/link`.",
      };
    }

    // Check if the SteamID is already linked to another Discord user
    const existingSteam = this.linkRepo.getLinkBySteam(codeRecord.steamId);
    if (existingSteam) {
      return {
        success: false,
        error: `This Steam account (\`${codeRecord.steamId}\`) is already linked to Discord user <@${existingSteam.discord_id}>.`,
      };
    }

    // Save link in database
    const linkResult = this.linkRepo.linkAccount(codeRecord.steamId, cleanDiscordId);

    if (typeof this.onLinkCompleted === "function") {
      try {
        await this.onLinkCompleted({
          steamId: codeRecord.steamId,
          discordId: cleanDiscordId,
          playerName: codeRecord.playerName,
          serverId: codeRecord.serverId,
          code: cleanCode,
          guild,
        });
      } catch (err) {
        console.warn(`[linkService] Role sync hook error: ${err.message}`);
      }
    }

    return {
      success: true,
      steamId: codeRecord.steamId,
      playerName: codeRecord.playerName,
      serverId: codeRecord.serverId,
      discordId: cleanDiscordId,
      linkedAt: linkResult.linkedAt,
    };
  }

  unlink({ discordId, steamId }) {
    if (discordId) {
      return this.linkRepo.unlinkByDiscord(discordId);
    }
    if (steamId) {
      return this.linkRepo.unlinkBySteam(steamId);
    }
    return false;
  }
}

module.exports = { LinkService };
