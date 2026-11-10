# mPanelBot

Standalone Discord bot and embedded WebSocket backend for Unturned game networks running the **mPanel** RocketMod plugin.

[![Node.js Version](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue.svg)](https://discord.js.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Architecture

- **Single Process**: Hosts both the Discord.js bot client and the persistent WebSocket server. No separate microservices or extra dependencies.
- **Node.js 22+ & Built-in SQLite**: Uses Node's built-in `node:sqlite` (`DatabaseSync`) with WAL mode and busy timeout handling for high performance.
- **WebSocket Protocol v1**: Persistent, two-way, authenticated communication with Unturned Rocket plugin instances on the `/ws` endpoint.
- **Security-First**: Timing-safe Bearer API key authentication, bounded outbound queues, command allowlists, redaction of sensitive parameters, and prevention of OS shell execution.
- **Discord Integrations**: In-game player link/unlink account sync, linked role grants, chat relay, raid alerts, moderation commands (`/ban`, `/kick`, `/mute`, `/warn`), player stats and leaderboards.
- **Optional Pterodactyl Integration**: Client API fallback for console commands when direct WebSocket connection is offline (disabled by default).

---

## Prerequisites

- **Node.js 22.0.0 or higher** (recommended for native `node:sqlite` database support).
- A **Discord Bot Application & Token** (from [Discord Developer Portal](https://discord.com/developers/applications)).
  - Requires `Guilds`, `GuildMessages`, `MessageContent`, and `GuildMembers` gateway intents. **Enable the `Server Members` and `Message Content` privileged intents** in the Discord Developer Portal (Bot tab) or login fails.

---

## Pterodactyl Generic Node.js Egg Deployment

`mPanelBot` is designed to be installed and deployed directly via Pterodactyl using its Git repository installation feature.

### 1. Create Server in Pterodactyl
- **Egg**: Generic Node.js Egg (ParkerVCP yolks or standard Node.js egg).
- **Docker Image**: Node.js 22 (e.g. `ghcr.io/parkervcp/yolks:nodejs_22` or `node:22-bookworm-slim`).
- **Primary Allocation**: Allocate a port for the WebSocket/API server (e.g. `28600`).

### 2. Configure Git Repository
In the server installation settings or Startup tab:
- **Git Repo**: `https://github.com/xalhexi-sch/mPanelBot.git`
- **Git Branch**: `main`
- **Main File / Entrypoint**: `src/index.js`
- **Startup Command**: `npm start` (or `node src/index.js`)
- **Auto-Update on Boot**: Optional (enabled if you want git pull on restart)

### 3. Configure the Bot
You can configure the bot using either the **Configuration File** or **Environment Variables**:

#### Method A: Configuration File (Recommended)
1. In the Pterodactyl **File Manager**, copy `config.example.json` to `config.json`.
2. Edit `config.json` with your credentials:
   ```json
   {
     "discord": {
       "token": "YOUR_DISCORD_BOT_TOKEN",
       "clientId": "YOUR_APPLICATION_CLIENT_ID"
     },
     "network": {
       "bindAddress": "0.0.0.0",
       "port": 28600,
       "apiKey": "YOUR_SHARED_SECRET_API_KEY",
       "heartbeatIntervalMs": 30000,
       "maxPayloadSizeBytes": 262144
     },
     "storage": {
       "sqlitePath": "./data/mpanel.sqlite"
     },
     "integrations": {
       "pterodactyl": {
         "enabled": false,
         "panelUrl": "https://panel.example.com",
         "clientApiToken": "YOUR_PTERODACTYL_CLIENT_API_KEY",
         "serverIdentifier": "YOUR_PTERODACTYL_SERVER_ID"
       }
     }
   }
   ```
   > **Note**: If your Pterodactyl server is allocated a port other than `28600`, update `"port"` to match your assigned allocation, or the bot will auto-detect `SERVER_PORT`.

#### Method B: Container Environment Variables
Alternatively, you can supply variables in the Pterodactyl Startup tab:
- `DISCORD_TOKEN`: Your Discord bot token.
- `DISCORD_CLIENT_ID`: Your Discord application ID.
- `MPANEL_API_KEY`: Shared API key for WebSocket authentication.
- `PORT` or `SERVER_PORT`: Assigned container port (auto-set by Pterodactyl).
- `SQLITE_PATH`: Path to SQLite database (defaults to `./data/mpanel.sqlite`).

### 4. Database Persistence
The SQLite database persists in `./data/mpanel.sqlite`. In Pterodactyl, the server root directory `/home/container/` persists across server stops, starts, and restarts.

### 5. Start the Server
Click **Start** in the Pterodactyl Console. The bot will:
1. Connect to Discord Gateway.
2. Register slash commands.
3. Start the WebSocket server on the configured port.
4. Open the HTTP health endpoint at `http://<IP>:<PORT>/health`.

---

## Local / VPS Setup

1. **Clone repository**:
   ```bash
   git clone https://github.com/xalhexi-sch/mPanelBot.git
   cd mPanelBot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run interactive setup wizard**:
   ```bash
   npm run setup
   ```
   The wizard will:
   - Prompt securely for your Discord Bot Token and Client ID.
   - Generate a cryptographically secure 32-byte hex API key.
   - Generate and write `config.json`.
   - Output the Rocket XML snippet to copy into your Unturned server configuration.

4. **Start the bot**:
   ```bash
   npm start
   ```

5. **Run test suite**:
   ```bash
   npm test
   ```

---

## Unturned RocketMod Plugin Connection

Configure your Unturned server's `mPanel.configuration.xml` using the bot's WebSocket URL and shared API key:

```xml
<Configuration>
  <WebSocketUrl>ws://YOUR_BOT_SERVER_IP:28600/ws</WebSocketUrl>
  <ApiKey>YOUR_SHARED_SECRET_API_KEY</ApiKey>
  <ServerId>survival-1</ServerId>
</Configuration>
```

> **Note**: For remote deployments behind SSL/reverse proxy, use `wss://yourdomain.com/ws`.

---

## Discord Slash Commands

### Server Setup (Admin Only)
- `/setup channels`: Configure channels for raid alerts, chat relay, connect/disconnect logs, command audit logs, and punishment logs.
- `/setup roles`: Set linked player role and staff moderation roles.
- `/setup show`: Display active guild configuration.

### Player Commands
- `/link code: <6-char-code>`: Link Steam64 ID using an in-game generated one-time code.
- `/unlink`: Unlink Steam account and remove synced Discord roles.
- `/stats [steamid] [user]`: View player stats (kills, deaths, K/D, headshots, playtime).
- `/ranking [metric]`: Top 10 leaderboards for kills, playtime, or deaths.
- `/compare steamid1: <id> steamid2: <id>`: Side-by-side player stats comparison.
- `/status [server]`: Live Unturned server status and online players.

### Moderation (Staff Only)
- `/ban steam64id: <id> [reason] [duration] [server]`: Ban player.
- `/kick steam64id: <id> [reason] [server]`: Kick player.
- `/mute steam64id: <id> [reason] [duration] [server]`: Mute player.
- `/warn steam64id: <id> [reason] [server]`: Warn player.
- `/unban steam64id: <id> [server]`: Unban player.
- `/unmute steam64id: <id> [server]`: Unmute player.
- `/run command: <command> [server]`: Execute approved game console command (strictly protected by allowlist; OS shell commands strictly blocked).

---

## Testing & Verification

Run the test suite with:

```bash
npm test
```

Includes 39 tests covering:
- Timing-safe WebSocket authentication.
- Command policy and injection prevention.
- Event deduplication and idempotency.
- DiscordLogger message formatting and sensitive argument redaction.
- One-time link code generation, TTL expiry, and atomic redemption.
- Queue overflow bounds and reconnect replay handling.
- Linked role sync decision logic.

## Live status & leaderboard panels

Run `/setup panels status_channel:#status leaderboard_channel:#leaderboards` (Administrator only).
The bot posts **one** message per panel and edits it in place (status every 30 s, leaderboard every 60 s).
Channel and message IDs are stored in SQLite; if the message is deleted a fresh one is posted automatically.
`/setup panels disable:true` stops updating them. `/status`, `/ranking`, `/stats` and `/compare` use the same embed designs.

## Optional: read stats from an existing MySQL `PlayerStats` table

SQLite (fed by plugin events) is the default. To show stats from a legacy MySQL table instead, add this to `config.json`
(bot-side only — never in the plugin config). The connection is read-only, uses parameterised queries, and the bot falls back to SQLite if MySQL is unreachable.

```json
"integrations": {
  "mysql": {
    "enabled": true,
    "host": "127.0.0.1", "port": 3306,
    "user": "readonly_user", "password": "CHANGE_ME", "database": "unturned",
    "table": "PlayerStats",
    "playtimeUnit": "seconds",
    "columns": { "steamId": "SteamId", "name": "Name", "kills": "Kills", "headshots": "Headshots", "deaths": "PVPDeaths", "playtime": "Playtime" }
  }
}
```

## Tests

`npm test` runs unit tests plus `test/e2e.test.js`, which drives the real WebSocket server with a fake plugin client
using the exact payload shapes the C# plugin emits (stats, snapshots, logs, raid fan-out, link flow, moderation round trip).

## Security hardening

- **Transport:** the API key is sent in the WebSocket handshake. The plugin refuses plain `ws://` unless the bot is on loopback, a private/container network or a VPN; use `wss://` for anything remote. Same-host Pterodactyl setups can use the bot container's name, e.g. `ws://<bot-container-id>:27022/ws`.
- **Login lockout:** 5 wrong keys within a minute block that address for 5 minutes (`429`). Each connection is also rate-limited (default 40 msg/s sustained, burst 200; `network.messageRatePerSec` / `network.messageBurst`).
- **Per-server keys (optional):** add `"network": { "serverKeys": { "survival-1": "<24+ char secret>" } }`. A server with its own key can no longer be impersonated with the shared key, and its key cannot speak for any other server.
- **Health endpoint:** `GET /health` returns only `{"status":"ok"}`. Connected-server details need `Authorization: Bearer <shared key>`.
- **Stored secrets:** a dedicated `security.encryptionKey` is generated into `config.json` on first start (file mode 0600) and existing secrets are migrated, so rotating the API key never locks the bot out of its own data.
- **Dependencies** are pinned to exact versions; run `npm audit` after updates.
