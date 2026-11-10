const crypto = require("node:crypto");

/**
 * Redacts any Discord webhook URLs or tokens to prevent leaking credentials in logs,
 * errors, or command responses.
 * Replaces the secret token portion with bullets (••••••••).
 */
function redactWebhookUrl(urlOrText) {
  if (!urlOrText || typeof urlOrText !== "string") return urlOrText;
  return urlOrText.replace(
    /(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi,
    "$1••••••••"
  );
}

/** Derives a 32-byte key from a secret. There is deliberately NO built-in default: a missing secret is a bug. */
function deriveKey(secret) {
  if (!secret || typeof secret !== "string") {
    throw new Error("An encryption secret is required (security.encryptionKey in config.json).");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypts sensitive plaintext (such as a Discord Webhook URL) using AES-256-GCM.
 * Formatted as: enc:<iv-hex>:<authTag-hex>:<ciphertext-hex>
 */
function encryptText(plainText, secret) {
  if (!plainText || typeof plainText !== "string") return null;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts text previously encrypted with encryptText.
 * `secret` may be one secret or an array tried in order (current key first, then legacy keys for migration).
 * Returns null when nothing decrypts it. Strings without the 'enc:' prefix are legacy plaintext and returned as-is.
 */
function decryptText(cipherText, secret) {
  if (!cipherText || typeof cipherText !== "string") return null;
  if (!cipherText.startsWith("enc:")) return cipherText;

  const parts = cipherText.slice(4).split(":");
  if (parts.length !== 3) return null;
  const [ivHex, tagHex, dataHex] = parts;

  for (const candidate of [].concat(secret)) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(candidate), Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
    } catch {
      // wrong key or tampered data: try the next candidate
    }
  }
  return null;
}

/** True when `cipherText` decrypts with the FIRST (current) secret, i.e. needs no migration. */
function isEncryptedWith(cipherText, secret) {
  if (typeof cipherText !== "string" || !cipherText.startsWith("enc:")) return false;
  return decryptText(cipherText, [secret]) !== null;
}

module.exports = { redactWebhookUrl, encryptText, decryptText, isEncryptedWith };
