# mPanelBot — Developer & Architecture Guide for Claude

## Project Overview & Repository Layout
**mPanelBot** is the single Discord Bot and embedded WebSocket gateway process for the mPanel network:
1. **`mPanelBot` (This Directory - `C:\Projects\UnturnedPlugins\mPanelBot`):**
   - Node.js (CommonJS, `>=22.0.0`), `discord.js` v14, `ws`, SQLite (default), optional MySQL stats fallback.
   - Embedded WebSocket gateway server: `src/websocket/server.js`.
   - Message routing: `src/websocket/router.js`.
   - Discord handlers:
     - Raid Alerts: `src/discord/raid/`
     - Logging: `src/discord/logs/`
     - Chat Relay: `src/discord/relay/`
     - Moderation & Setup: `src/discord/commands/`
2. **`mPanel` (Sibling Directory - `C:\Projects\UnturnedPlugins\mPanel`):**
   - The RocketMod game plugin (`mPanel.dll`, .NET Framework 4.8) installed on each Unturned server.
   - Connects outbound to this bot's WebSocket gateway.

---

## Architectural Separation: Raid Alerts vs. Logging

In `mPanelBot`, Raid Alerts and Logging are strictly separated internally:
- **Raid Alerts (`src/discord/raid/`):**
  - Consumes high-priority `raid.alert` events from `src/websocket/router.js`.
  - Resolves target Discord users (owner + linked group members).
  - Handles raid embeds, notification preferences (DMs or designated raid alert channel), and debounce protection.
- **Discord Logging (`src/discord/logs/`):**
  - Consumes `log.chat`, `log.command`, `log.connection`, and `log.punishment` events from `src/websocket/router.js`.
  - Dispatches to designated channels (`joinLeaveChannelId`, `commandLogChannelId`, `punishmentLogChannelId`).
  - Redacts sensitive command parameters (passwords, auth codes) via `sanitizeLoggedCommand`.

---

## Non-Negotiable Core Laws

1. **Single Backend Process:**
   - The bot process directly hosts the WebSocket server. Never split into a separate microservice or Python script.
2. **Persistence Rules:**
   - SQLite is the primary database.
   - Zero persistence for in-game chat messages: chat messages must **never** be inserted into SQLite.
3. **Loop Prevention & Security:**
   - Ignore bot messages (`message.author.bot`) and webhook messages (`message.webhookId`) in chat relays.
   - Enforce command allowlists and Steam64 ID validation. Reject OS shell injection patterns.
   - Timing-safe authentication for WebSocket handshakes.
4. **Resilience & Rate Limiting:**
   - Steam API calls are cached, throttled, and rate-limited. If Steam fails, fall back gracefully without crashing.
   - Bounded queues for WebSocket sessions with oldest-drop backpressure on overflow.

---

## Test & Run Commands

- **Run all automated unit & integration tests:**
  ```powershell
  npm test
  ```
- **Start setup wizard:**
  ```powershell
  npm run setup
  ```
- **Start bot process:**
  ```powershell
  npm start
  ```
