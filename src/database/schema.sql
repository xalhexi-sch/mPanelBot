-- mPanel SQLite Schema Definition
-- Default managed storage for mPanel Discord Bot & WebSocket Backend

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Key-value settings table
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Guild configuration for channels and roles
CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id TEXT PRIMARY KEY,
    raid_channel_id TEXT,
    chat_channel_id TEXT,
    join_leave_channel_id TEXT,
    command_log_channel_id TEXT,
    punishment_log_channel_id TEXT,
    linked_role_id TEXT,
    status_channel_id TEXT,
    status_message_id TEXT,
    leaderboard_channel_id TEXT,
    leaderboard_message_id TEXT,
    admin_role_ids TEXT DEFAULT '[]',
    updated_at TEXT NOT NULL
);

-- Persistent account links between Steam64 and Discord
CREATE TABLE IF NOT EXISTS account_links (
    steam_id TEXT PRIMARY KEY,
    discord_id TEXT UNIQUE NOT NULL,
    raid_alerts_dm INTEGER NOT NULL DEFAULT 1,
    linked_at TEXT NOT NULL
);

-- Temporary one-time linking codes generated in-game (10 min TTL)
CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL,
    player_name TEXT NOT NULL,
    server_id TEXT NOT NULL,
    expires_at_utc TEXT NOT NULL,
    created_at_utc TEXT NOT NULL
);

-- In-game player statistics aggregates
CREATE TABLE IF NOT EXISTS player_stats (
    steam_id TEXT PRIMARY KEY,
    player_name TEXT NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    headshots INTEGER NOT NULL DEFAULT 0,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    last_seen_at_utc TEXT NOT NULL
);

-- Idempotency table for durable events
CREATE TABLE IF NOT EXISTS processed_events (
    server_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    processed_at_utc TEXT NOT NULL,
    PRIMARY KEY (server_id, event_id)
);

-- Audit log for console and moderation actions
CREATE TABLE IF NOT EXISTS command_audits (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    command_name TEXT NOT NULL,
    full_command TEXT NOT NULL,
    target_steam_id TEXT,
    requested_by_discord_id TEXT NOT NULL,
    requested_by_tag TEXT,
    executed_via TEXT NOT NULL,
    success INTEGER NOT NULL,
    result_message TEXT,
    created_at_utc TEXT NOT NULL
);

-- Latest server status snapshots
CREATE TABLE IF NOT EXISTS server_snapshots (
    server_id TEXT PRIMARY KEY,
    server_name TEXT,
    map TEXT,
    server_steam_id TEXT,
    online_count INTEGER NOT NULL DEFAULT 0,
    max_players INTEGER NOT NULL DEFAULT 0,
    players_json TEXT,
    updated_at_utc TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_player_stats_kills ON player_stats(kills DESC);
CREATE INDEX IF NOT EXISTS idx_player_stats_playtime ON player_stats(playtime_seconds DESC);
CREATE INDEX IF NOT EXISTS idx_player_stats_deaths ON player_stats(deaths DESC);
CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON link_codes(expires_at_utc);
CREATE INDEX IF NOT EXISTS idx_processed_events_processed_at ON processed_events(processed_at_utc);

-- Steam group names (looked up from Steam Community and cached to survive rate limits / outages)
CREATE TABLE IF NOT EXISTS steam_groups (
    group_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT,
    fetched_at_utc TEXT NOT NULL
);
