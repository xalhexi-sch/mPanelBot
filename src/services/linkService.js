class LinkService {
  constructor({
    linkRepo,
    onLinkCompleted = null,
    onUnlinkCompleted = null,
    maxBadAttempts = 5,
    lockoutMs = 10 * 60_000,
    now = Date.now,
  }) {
    this.linkRepo = linkRepo;
    this.onLinkCompleted = onLinkCompleted;
    this.onUnlinkCompleted = onUnlinkCompleted;
    this.maxBadAttempts = maxBadAttempts;
    this.lockoutMs = lockoutMs;
    this.now = now;
    this.attempts = new Map(); // discordId -> { bad, firstAt, lockedUntil }
  }

  _lockedFor(discordId) {
    const e = this.attempts.get(discordId);
    if (!e || !e.lockedUntil) return 0;
    const left = e.lockedUntil - this.now();
    if (left <= 0) {
      this.attempts.delete(discordId);
      return 0;
    }
    return left;
  }

  _recordBad(discordId) {
    const t = this.now();
    let e = this.attempts.get(discordId);
    if (!e || t - e.firstAt > this.lockoutMs) e = { bad: 0, firstAt: t, lockedUntil: 0 };
    e.bad++;
    if (e.bad >= this.maxBadAttempts) e.lockedUntil = t + this.lockoutMs;
    this.attempts.delete(discordId);
    this.attempts.set(discordId, e);
    while (this.attempts.size > 5000) this.attempts.delete(this.attempts.keys().next().value);
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

    // Brute-force guard: a handful of wrong codes locks this Discord user out for a while.
    const lockedMs = this._lockedFor(cleanDiscordId);
    if (lockedMs > 0) {
      return { success: false, error: `Too many invalid codes. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).` };
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
      this._recordBad(cleanDiscordId);
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

    this.attempts.delete(cleanDiscordId);

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

  async unlink({ discordId, steamId }) {
    let existing = null;
    if (discordId) {
      existing = this.linkRepo.getLinkByDiscord(discordId);
      if (!existing) return null;
      this.linkRepo.unlinkByDiscord(discordId);
    } else if (steamId) {
      existing = this.linkRepo.getLinkBySteam(steamId);
      if (!existing) return null;
      this.linkRepo.unlinkBySteam(steamId);
    } else {
      return null;
    }

    if (typeof this.onUnlinkCompleted === "function") {
      try {
        await this.onUnlinkCompleted({
          steamId: existing.steam_id,
          discordId: existing.discord_id,
        });
      } catch (err) {
        console.warn(`[linkService] Unlink hook error: ${err.message}`);
      }
    }

    return existing;
  }
}

module.exports = { LinkService };
