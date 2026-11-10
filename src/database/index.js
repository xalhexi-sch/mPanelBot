const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class DatabaseManager {
  constructor(dbPath = ":memory:") {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    const schemaPath = path.join(__dirname, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, "utf8");
      this.db.exec(schemaSql);
    }

    // Idempotent column additions for databases created by an older schema version
    try {
      const have = new Set(this.db.prepare("PRAGMA table_info(guild_configs);").all().map((c) => c.name));
      for (const col of [
        "chat_webhook_url",
        "status_channel_id",
        "status_message_id",
        "leaderboard_channel_id",
        "leaderboard_message_id",
      ]) {
        if (have.size > 0 && !have.has(col)) this.db.exec(`ALTER TABLE guild_configs ADD COLUMN ${col} TEXT;`);
      }
    } catch {}
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn(this.db);
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw err;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

module.exports = { DatabaseManager };
