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

/**
 * Derives a deterministic 32-byte key from a secret string.
 */
function deriveKey(secret) {
  const keyMaterial = secret || "mPanel-default-internal-storage-key-2026";
  return crypto.createHash("sha256").update(keyMaterial).digest();
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
 * Decrypts sensitive text previously encrypted with encryptText.
 * Safely falls back to plaintext if the string does not have the 'enc:' prefix.
 */
function decryptText(cipherText, secret) {
  if (!cipherText || typeof cipherText !== "string") return null;
  if (!cipherText.startsWith("enc:")) {
    // Unencrypted legacy/raw fallback
    return cipherText;
  }
  try {
    const parts = cipherText.slice(4).split(":");
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, dataHex] = parts;
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

module.exports = {
  redactWebhookUrl,
  encryptText,
  decryptText,
};
