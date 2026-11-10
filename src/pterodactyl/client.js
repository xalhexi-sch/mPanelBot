/**
 * Optional Pterodactyl Client Integration.
 * Authority for panel operations when game WebSocket is not connected or when configured.
 */

class PterodactylClient {
  constructor({ enabled = false, panelUrl = "", clientApiToken = "", serverIdentifier = "" } = {}) {
    this.enabled = Boolean(enabled);
    this.panelUrl = String(panelUrl || "").replace(/\/$/, "");
    this.clientApiToken = String(clientApiToken || "");
    this.serverIdentifier = String(serverIdentifier || "");
  }

  isConfigured() {
    return this.enabled && !!this.panelUrl && !!this.clientApiToken && !!this.serverIdentifier;
  }

  async sendCommand(command, timeoutMs = 10000) {
    if (!this.isConfigured()) {
      throw new Error("Pterodactyl integration is not enabled or not fully configured.");
    }

    const cleanCommand = String(command || "").trim();
    if (!cleanCommand) {
      throw new Error("Command cannot be empty.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.panelUrl}/api/client/servers/${this.serverIdentifier}/command`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.clientApiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command: cleanCommand }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = response.statusText;
        try {
          const body = await response.json();
          detail = body?.errors?.[0]?.detail || body?.message || detail;
        } catch {}
        throw new Error(`Pterodactyl API error (${response.status}): ${detail}`);
      }

      return {
        success: true,
        command: cleanCommand,
        status: response.status,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PterodactylClient };
