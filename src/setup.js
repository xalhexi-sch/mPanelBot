const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");
const { DEFAULT_CONFIG_PATH } = require("./config");

function generateSecureApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

async function prompt(rl, question, defaultValue = "") {
  return new Promise((resolve) => {
    const q = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(q, (answer) => {
      const val = answer.trim();
      resolve(val || defaultValue);
    });
  });
}

async function runSetup() {
  console.log("==================================================");
  console.log("        mPanel Bot & Backend First-Run Setup      ");
  console.log("==================================================");

  const configPath = DEFAULT_CONFIG_PATH;
  let existingConfig = {};

  if (fs.existsSync(configPath)) {
    console.log(`\nFound existing config at ${configPath}.`);
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {}
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const defaultToken = existingConfig?.discord?.token || "";
    const token = await prompt(rl, "Enter your Discord Bot Token", defaultToken);
    if (!token) {
      console.error("❌ Error: Discord Bot Token is required to run mPanel Bot.");
      process.exit(1);
    }

    const defaultClientId = existingConfig?.discord?.clientId || "";
    const clientId = await prompt(rl, "Enter Discord Application Client ID (optional, for slash commands)", defaultClientId);

    const defaultPort = existingConfig?.network?.port || 28600;
    const portStr = await prompt(rl, "Enter WebSocket/API bind port", String(defaultPort));
    const port = parseInt(portStr, 10) || 28600;

    const defaultGuilds = (existingConfig?.discord?.guildIds || []).join(",");
    const guildsRaw = await prompt(rl, "Your Discord server (guild) ID(s), comma separated (recommended: locks the bot to your server)", defaultGuilds);
    const guildIds = guildsRaw.split(",").map((s) => s.trim()).filter((s) => /^\d{5,25}$/.test(s));

    let apiKey = existingConfig?.network?.apiKey;
    let isNewKey = false;
    if (!apiKey || apiKey.startsWith("PASTE_") || apiKey.startsWith("GENERATED_")) {
      apiKey = generateSecureApiKey();
      isNewKey = true;
    }

    // Merge over the existing file so re-running setup never erases serverKeys, MySQL/Pterodactyl settings or tuning.
    const config = {
      ...existingConfig,
      discord: { ...(existingConfig.discord || {}), token: token.trim(), clientId: clientId.trim() || null, guildIds },
      network: {
        heartbeatIntervalMs: 30000,
        maxPayloadSizeBytes: 262144,
        ...(existingConfig.network || {}),
        bindAddress: existingConfig?.network?.bindAddress || "0.0.0.0",
        port,
        apiKey,
      },
      storage: { sqlitePath: existingConfig?.storage?.sqlitePath || "./data/mpanel.sqlite" },
      integrations: {
        pterodactyl: { enabled: false, panelUrl: "", clientApiToken: "", serverIdentifier: "" },
        ...(existingConfig.integrations || {}),
      },
    };

    // Owner-only file: it holds the bot token and API key.
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
    console.log(`\n✅ Configuration successfully saved to: ${configPath}`);

    if (isNewKey) {
      console.log("\n==================================================");
      console.log("⚠️  IMPORTANT: SHARED API KEY GENERATED");
      console.log("==================================================");
      console.log("Your generated API Key is:\n");
      console.log(`   ${apiKey}\n`);
      console.log("Configure this key in your Unturned Rocket plugin XML config:");
      console.log(`
<Configuration>
  <WebSocketUrl>ws://localhost:${port}/ws</WebSocketUrl>
  <ApiKey>${apiKey}</ApiKey>
  <ServerId>survival-1</ServerId>
</Configuration>
`);
      console.log("Keep this key private. It will NOT be printed again.");
      console.log("==================================================\n");
    }

    console.log("Setup complete! You can now start the bot with:\n   npm start\n");
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  runSetup().catch((err) => {
    console.error("Setup error:", err.message);
    process.exit(1);
  });
}

module.exports = { runSetup, generateSecureApiKey };
