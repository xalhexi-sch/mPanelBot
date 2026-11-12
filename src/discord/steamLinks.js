/**
 * Replies with the bare Steam64 ID for every steamcommunity.com profile link in a message (servers and DMs).
 * Numeric `/profiles/<id>` links need no lookup; `/id/<vanity>` links are resolved through SteamAvatarService
 * (Steam Web API first, then XML profile, then HTML scrape). Output is plain text, one ID per line.
 */
const MAX_LINKS_PER_MESSAGE = 5;

const STEAM_LINK = /https?:\/\/(?:www\.)?steamcommunity\.com\/(?:profiles\/(\d{17})|id\/([A-Za-z0-9_-]{2,64}))(?![A-Za-z0-9_-])/gi;

/** @returns {Array<{label:string, steamId:string|null, vanity:string|null}>} unique links in order of appearance */
function extractSteamLinks(content, limit = MAX_LINKS_PER_MESSAGE) {
  const seen = new Set();
  const links = [];
  for (const m of String(content || "").matchAll(STEAM_LINK)) {
    const steamId = m[1] || null;
    const vanity = m[2] || null;
    const key = steamId || `id:${vanity.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ label: steamId || vanity, steamId, vanity });
    if (links.length >= limit) break;
  }
  return links;
}

/** Builds the reply text (plain, one line per link), or null when the message has no Steam profile links. */
async function buildSteamLinkReply(content, steam) {
  const links = extractSteamLinks(content);
  if (!links.length) return null;

  const lines = [];
  for (const link of links) {
    let id = link.steamId;
    if (!id) {
      try {
        id = await steam.resolveVanity(link.vanity);
      } catch {
        id = null;
      }
    }
    lines.push(id || `${link.label} not found`);
  }
  return lines.join("\n");
}

/** Never throws; ignores bots and webhooks (chat-relay loop prevention rules apply here too). */
async function handleSteamLinkMessage(message, steam) {
  if (!steam || message.author?.bot || message.webhookId) return;
  const reply = await buildSteamLinkReply(message.content, steam);
  if (reply) await message.reply({ content: reply, allowedMentions: { parse: [], repliedUser: false } });
}

module.exports = { extractSteamLinks, buildSteamLinkReply, handleSteamLinkMessage, MAX_LINKS_PER_MESSAGE };
