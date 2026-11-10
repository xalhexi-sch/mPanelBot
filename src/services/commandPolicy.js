/**
 * Enforces policy for console and moderation commands.
 * Strictly prevents OS shell injection and unauthorized execution.
 */

const ALLOWED_CONSOLE_COMMANDS = new Set([
  "admin",
  "unadmin",
  "airdrop",
  "broadcast",
  "say",
  "day",
  "night",
  "experience",
  "give",
  "vehicle",
  "teleport",
  "maxplayers",
  "save",
  "shutdown",
  "storm",
  "weather",
  "flag",
  "quest",
  "p", // Rocket permissions command
  "rocket",
  "kick",
  "ban",
  "unban",
  "mute",
  "unmute",
  "warn",
]);

const FORBIDDEN_SHELL_PATTERNS = [
  /[;&|`$<>]/,             // Shell operators
  /[\r\n]/,                 // CRLF injection
  /\bcmd(?:\.exe)?\b/i,     // Windows cmd
  /\bpowershell(?:\.exe)?\b/i, // PowerShell
  /\bbash\b/i,
  /\bsh\b/i,
  /\bwget\b/i,
  /\bcurl\b/i,
  /\bformat\b/i,
  /\brm\b/i,
  /\bdel\b/i,
];

function sanitizeString(input, maxLength = 250) {
  return String(input || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseDurationToMinutes(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Math.max(1, Number(raw));

  let totalSeconds = 0;
  let reconstructed = "";
  const re = /(\d+)\s*(w|week|weeks|d|day|days|h|hr|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/g;
  let match;
  let matchedAny = false;

  while ((match = re.exec(raw)) !== null) {
    matchedAny = true;
    reconstructed += match[0];
    const amount = Number(match[1]);
    const unit = match[2];

    if (unit.startsWith("w")) totalSeconds += amount * 7 * 86400;
    else if (unit.startsWith("d")) totalSeconds += amount * 86400;
    else if (unit.startsWith("h")) totalSeconds += amount * 3600;
    else if (unit.startsWith("m")) totalSeconds += amount * 60;
    else if (unit.startsWith("s")) totalSeconds += amount;
  }

  if (!matchedAny || totalSeconds <= 0) return null;

  // Verify all characters were accounted for (matches C# ModerationValidator)
  const strippedOriginal = raw.replace(/\s+/g, "");
  const strippedReconstructed = reconstructed.replace(/\s+/g, "");
  if (strippedOriginal !== strippedReconstructed) {
    return null;
  }

  return Math.max(1, Math.round(totalSeconds / 60));
}

function validateSteam64(steam64) {
  const sid = String(steam64 || "").trim();
  if (!/^\d{17}$/.test(sid)) {
    return { valid: false, error: "Invalid Steam64 ID. Must be exactly 17 digits." };
  }
  return { valid: true, steamId: sid };
}

function validateConsoleCommand(rawCommand, allowCustomPolicy = false) {
  const clean = sanitizeString(rawCommand, 500).replace(/^\/+/, "");
  if (!clean) {
    return { allowed: false, error: "Command string cannot be empty." };
  }

  // Check for forbidden OS shell patterns
  for (const pattern of FORBIDDEN_SHELL_PATTERNS) {
    if (pattern.test(clean)) {
      return { allowed: false, error: "Security violation: Shell operators or dangerous commands are forbidden." };
    }
  }

  const parts = clean.split(" ");
  const baseCommand = parts[0].toLowerCase();

  if (!allowCustomPolicy && !ALLOWED_CONSOLE_COMMANDS.has(baseCommand)) {
    return {
      allowed: false,
      error: `Command '${baseCommand}' is not in the allowed console commands policy.`,
    };
  }

  return {
    allowed: true,
    baseCommand,
    sanitizedCommand: clean,
    args: parts.slice(1),
  };
}

function buildModerationCommand(action, steam64, reason = "", duration = null) {
  const steamVal = validateSteam64(steam64);
  if (!steamVal.valid) {
    throw new Error(steamVal.error);
  }

  const sid = steamVal.steamId;
  const cleanReason = sanitizeString(reason || "No reason specified", 150);

  let minutes = null;
  if (duration !== null && duration !== undefined && String(duration).trim() !== "") {
    minutes = parseDurationToMinutes(duration);
    if (minutes === null) {
      throw new Error(`Invalid duration: '${duration}'. Use formats like '30m', '2h', '1d', or '1w'.`);
    }
  }

  let fullCommand = "";
  const act = action.toLowerCase().trim();

  switch (act) {
    case "ban":
      fullCommand = minutes != null
        ? `ban ${sid} ${minutes} ${cleanReason}`
        : `ban ${sid} ${cleanReason}`;
      break;
    case "mute":
      fullCommand = minutes != null
        ? `mute ${sid} ${minutes} ${cleanReason}`
        : `mute ${sid} ${cleanReason}`;
      break;
    case "warn":
      fullCommand = `warn ${sid} ${cleanReason}`;
      break;
    case "kick":
      fullCommand = `kick ${sid} ${cleanReason}`;
      break;
    case "unban":
      fullCommand = `unban ${sid}`;
      break;
    case "unmute":
      fullCommand = `unmute ${sid}`;
      break;
    default:
      throw new Error(`Unsupported moderation action: ${action}`);
  }

  return {
    action: act,
    targetSteamId: sid,
    reason: cleanReason,
    durationMinutes: minutes,
    fullCommand,
  };
}

module.exports = {
  ALLOWED_CONSOLE_COMMANDS,
  FORBIDDEN_SHELL_PATTERNS,
  sanitizeString,
  parseDurationToMinutes,
  validateSteam64,
  validateConsoleCommand,
  buildModerationCommand,
};
