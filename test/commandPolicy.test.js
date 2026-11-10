const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  validateSteam64,
  parseDurationToMinutes,
  buildModerationCommand,
  validateConsoleCommand,
} = require("../src/services/commandPolicy");

describe("Command Policy & Security Verification", () => {
  it("should validate valid Steam64 IDs and reject invalid ones", () => {
    assert.strictEqual(validateSteam64("76561198000000001").valid, true);
    assert.strictEqual(validateSteam64("12345").valid, false); // Too short
    assert.strictEqual(validateSteam64("76561198000000001999").valid, false); // Too long
    assert.strictEqual(validateSteam64("7656119800000000A").valid, false); // Non-digit
    assert.strictEqual(validateSteam64("").valid, false);
  });

  it("should correctly parse duration strings to minutes", () => {
    assert.strictEqual(parseDurationToMinutes("30m"), 30);
    assert.strictEqual(parseDurationToMinutes("2h"), 120);
    assert.strictEqual(parseDurationToMinutes("1d"), 1440);
    assert.strictEqual(parseDurationToMinutes("1w"), 10080);
    assert.strictEqual(parseDurationToMinutes("1h 30m"), 90);
    assert.strictEqual(parseDurationToMinutes("60"), 60); // Raw number treated as minutes
    assert.strictEqual(parseDurationToMinutes("invalid"), null);
    assert.strictEqual(parseDurationToMinutes("1.5h"), null); // Misparse prevented by reconstructed string check
    assert.strictEqual(parseDurationToMinutes("10m junk"), null);
    assert.strictEqual(parseDurationToMinutes("foo"), null);
  });

  it("should construct valid moderation command strings", () => {
    const ban1 = buildModerationCommand("ban", "76561198000000001", "Cheating", "1d");
    assert.strictEqual(ban1.fullCommand, "ban 76561198000000001 1440 Cheating");

    const banPerm = buildModerationCommand("ban", "76561198000000001", "Permanent ban");
    assert.strictEqual(banPerm.fullCommand, "ban 76561198000000001 Permanent ban");

    const mute = buildModerationCommand("mute", "76561198000000001", "Toxic behavior", "30m");
    assert.strictEqual(mute.fullCommand, "mute 76561198000000001 30 Toxic behavior");

    const warn = buildModerationCommand("warn", "76561198000000001", "First warning");
    assert.strictEqual(warn.fullCommand, "warn 76561198000000001 First warning");

    const kick = buildModerationCommand("kick", "76561198000000001", "AFK");
    assert.strictEqual(kick.fullCommand, "kick 76561198000000001 AFK");

    const unban = buildModerationCommand("unban", "76561198000000001");
    assert.strictEqual(unban.fullCommand, "unban 76561198000000001");

    // Invalid durations must throw rather than becoming permanent bans or mutes
    assert.throws(() => buildModerationCommand("ban", "76561198000000001", "Cheating", "foo"), /Invalid duration/);
    assert.throws(() => buildModerationCommand("ban", "76561198000000001", "Cheating", "1.5h"), /Invalid duration/);
    assert.throws(() => buildModerationCommand("mute", "76561198000000001", "Spam", "bad"), /Invalid duration/);
  });

  it("should reject dangerous OS shell injection patterns in console commands", () => {
    // Semicolon chaining
    const semi = validateConsoleCommand("broadcast Hello; rm -rf /");
    assert.strictEqual(semi.allowed, false);
    assert.match(semi.error, /security violation/i);

    // Pipe operator
    const pipe = validateConsoleCommand("broadcast Hello | powershell");
    assert.strictEqual(pipe.allowed, false);

    // Ampersand chaining
    const amp = validateConsoleCommand("say hi && cmd.exe /c calc");
    assert.strictEqual(amp.allowed, false);

    // Backticks
    const bt = validateConsoleCommand("say `whoami`");
    assert.strictEqual(bt.allowed, false);

    // CRLF newline injection
    const crlf = validateConsoleCommand("broadcast Hello\nformat C:");
    assert.strictEqual(crlf.allowed, false);
  });

  it("should enforce allowlist for safe game/Rocket console commands", () => {
    const validBroadcast = validateConsoleCommand("broadcast Welcome to the server!");
    assert.strictEqual(validBroadcast.allowed, true);
    assert.strictEqual(validBroadcast.baseCommand, "broadcast");

    const validGive = validateConsoleCommand("give 76561198000000001 363/1");
    assert.strictEqual(validGive.allowed, true);

    const validAirdrop = validateConsoleCommand("airdrop");
    assert.strictEqual(validAirdrop.allowed, true);

    // Disallowed unlisted command
    const unlisted = validateConsoleCommand("malicious_unlisted_command foo bar");
    assert.strictEqual(unlisted.allowed, false);
    assert.match(unlisted.error, /not in the allowed console commands policy/i);
  });
});
