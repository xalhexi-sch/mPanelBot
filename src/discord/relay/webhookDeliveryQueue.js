const { redactWebhookUrl } = require("../../utils/security");

/**
 * Bounded in-memory delivery queue for outbound Discord webhook messages.
 * Leverages Discord.js REST manager for HTTP 429 rate limit management while
 * enforcing an in-memory queue limit to prevent unbounded memory growth during
 * game-side chat bursts or prolonged network interruptions.
 */
class WebhookDeliveryQueue {
  constructor({ maxCapacity = 100, onWebhookInvalid = null } = {}) {
    this.maxCapacity = Math.max(1, maxCapacity);
    this.onWebhookInvalid = onWebhookInvalid;
    this.queue = [];
    this.isProcessing = false;
    this.droppedCount = 0;
    this.lastDropWarningUtc = 0;
  }

  get size() {
    return this.queue.length;
  }

  /**
   * Enqueues an outbound webhook delivery.
   * If the queue is at capacity, the oldest message is dropped to protect memory.
   */
  enqueue({ webhookClient, guildId, payload, meta = {} }) {
    if (!webhookClient || !payload) return false;

    if (this.queue.length >= this.maxCapacity) {
      this.queue.shift(); // Drop oldest message
      this.droppedCount++;
      const now = Date.now();
      if (now - this.lastDropWarningUtc > 10000) {
        this.lastDropWarningUtc = now;
        console.warn(
          `[chatRelay] In-memory webhook queue reached capacity (${this.maxCapacity}). Dropped ${this.droppedCount} message(s) to protect memory.`
        );
      }
    }

    this.queue.push({ webhookClient, guildId, payload, meta });
    this.processQueue();
    return true;
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      try {
        // Discord.js WebhookClient.send handles HTTP 429 rate limits internally
        await item.webhookClient.send(item.payload);
      } catch (err) {
        const errorMsg = redactWebhookUrl(err.message || String(err));
        const errorCode = err.code || err.status;

        // Detect deleted/invalid webhook (Discord API error 10015 or HTTP 404)
        if (errorCode === 10015 || errorCode === 404) {
          console.warn(
            `[chatRelay] Webhook for guild ${item.guildId} is invalid or was deleted in Discord (${errorMsg}). Invalidate client.`
          );
          if (typeof this.onWebhookInvalid === "function") {
            try {
              this.onWebhookInvalid({ guildId: item.guildId, error: err });
            } catch {}
          }
        } else {
          console.warn(`[chatRelay] Webhook delivery failed for guild ${item.guildId}: ${errorMsg}`);
        }
      }
    }

    this.isProcessing = false;
  }

  clear() {
    this.queue = [];
    this.isProcessing = false;
  }
}

module.exports = { WebhookDeliveryQueue };
