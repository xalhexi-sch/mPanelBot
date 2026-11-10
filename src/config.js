const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "../config.json");

function loadMysqlConfig(m = {}) {
  const c = m.columns || {};
  return {
    enabled: Boolean(m.enabled),
    host: m.host || "127.0.0.1",
    port: Number(m.port || 3306),
    user: m.user || "",
    password: m.password || "",
    database: m.database || "",
    table: m.table || "PlayerStats",
    playtimeUnit: m.playtimeUnit === "minutes" ? "minutes" : "seconds",
    columns: {
      steamId: c.steamId || "SteamId",
      name: c.name || "Name",
      kills: c.kills || "Kills",
      headshots: c.headshots || "Headshots",
      deaths: c.deaths || "PVPDeaths",
      playtime: c.playtime || "Playtime",
      zombies: c.zombies || "Zombies",
      megaZombies: c.megaZombies || "MegaZombies",
      resources: c.resources || "Resources",
      structures: c.structures || "Structures",
      barricades: c.barricades || "Barricades",
    },
  };
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let parsed = null;
  const configExists = fs.existsSync(configPath);

  if (configExists) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (err) {
      throw new Error(`Failed to read configuration file: ${err.message}`);
    }

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON syntax in configuration file: ${err.message}`);
    }
  }

  // Token resolution: Config file or environment variable
  const token = (parsed?.discord?.token || process.env.DISCORD_TOKEN)?.trim();
  if (!token || token === "YOUR_DISCORD_BOT_TOKEN" || token === "SET_DURING_FIRST_RUN") {
    if (!configExists) {
      throw new Error(
        `Configuration file not found at ${configPath}.\n` +
        `Please run first-time setup with: npm run setup\n` +
        `Or copy config.example.json to config.json and populate required fields (or supply DISCORD_TOKEN and MPANEL_API_KEY environment variables).`
      );
    }
    throw new Error("Missing or invalid Discord bot token in configuration.");
  }

  // API Key resolution: Config file or environment variable
  const apiKey = (parsed?.network?.apiKey || process.env.MPANEL_API_KEY || process.env.API_KEY)?.trim();
  if (!apiKey || apiKey === "PASTE_OR_GENERATE_SHARED_API_KEY" || apiKey === "GENERATED_ON_FIRST_RUN") {
    throw new Error("Missing or invalid API key in configuration.");
  }

  return {
    discord: {
      token,
      clientId: (parsed?.discord?.clientId || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID)
        ? String(parsed?.discord?.clientId || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID).trim()
        : null,
    },
    network: {
      bindAddress: process.env.BIND_ADDRESS || parsed?.network?.bindAddress || "0.0.0.0",
      port: Number(process.env.PORT || process.env.SERVER_PORT || parsed?.network?.port || 28600),
      apiKey,
      heartbeatIntervalMs: Number(parsed?.network?.heartbeatIntervalMs || 30000),
      maxPayloadSizeBytes: Number(parsed?.network?.maxPayloadSizeBytes || 262144),
    },
    storage: {
      sqlitePath: process.env.SQLITE_PATH || parsed?.storage?.sqlitePath || "./data/mpanel.sqlite",
    },
    integrations: {
      mysql: loadMysqlConfig(parsed?.integrations?.mysql),
      pterodactyl: {
        enabled: process.env.PTERO_ENABLED ? process.env.PTERO_ENABLED === "true" : Boolean(parsed?.integrations?.pterodactyl?.enabled),
        panelUrl: (process.env.PTERO_PANEL_URL || parsed?.integrations?.pterodactyl?.panelUrl || "").replace(/\/$/, ""),
        clientApiToken: process.env.PTERO_CLIENT_API_TOKEN || parsed?.integrations?.pterodactyl?.clientApiToken || "",
        serverIdentifier: process.env.PTERO_SERVER_IDENTIFIER || parsed?.integrations?.pterodactyl?.serverIdentifier || "",
      },
    },
  };
}

module.exports = { loadConfig, DEFAULT_CONFIG_PATH };
