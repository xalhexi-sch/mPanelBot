/**
 * Unified player-stats reader used by every Discord view (/stats, /ranking, /compare, live leaderboard).
 *
 * - Default source: the managed SQLite `player_stats` table, fed by plugin events.
 * - Optional source: a legacy MySQL `PlayerStats` table (read-only). Enabled with `integrations.mysql.enabled`.
 *   If MySQL is unreachable the service transparently falls back to SQLite so Discord commands never break.
 */

const IDENT = /^[A-Za-z0-9_]{1,64}$/;

function ident(value, label) {
  if (!IDENT.test(String(value))) throw new Error(`Invalid MySQL ${label}: only letters, digits and _ are allowed.`);
  return `\`${value}\``;
}

const METRICS = { kills: "kills", playtime: "playtime", deaths: "deaths" };

class MySqlStatsSource {
  constructor(cfg, mysqlModule = null) {
    this.cfg = cfg;
    this.mysql = mysqlModule || require("mysql2/promise");
    this.table = ident(cfg.table, "table");
    const c = cfg.columns;
    this.col = {
      steamId: ident(c.steamId, "column"),
      name: ident(c.name, "column"),
      kills: ident(c.kills, "column"),
      headshots: ident(c.headshots, "column"),
      deaths: ident(c.deaths, "column"),
      playtime: ident(c.playtime, "column"),
      zombies: ident(c.zombies || "Zombies", "column"),
      megaZombies: ident(c.megaZombies || "MegaZombies", "column"),
      resources: ident(c.resources || "Resources", "column"),
      structures: ident(c.structures || "Structures", "column"),
      barricades: ident(c.barricades || "Barricades", "column"),
    };
    this.playtimeFactor = cfg.playtimeUnit === "minutes" ? 60 : 1;
    this.pool = this.mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionLimit: 4,
      connectTimeout: 5000,
      waitForConnections: true,
      queueLimit: 50,
    });
  }

  _select() {
    const c = this.col;
    return (
      `CAST(${c.steamId} AS CHAR) AS steamId, ${c.name} AS playerName, ${c.kills} AS kills, ` +
      `${c.headshots} AS headshots, ${c.deaths} AS deaths, ${c.playtime} AS playtime`
    );
  }

  _map(r) {
    return {
      steam_id: String(r.steamId),
      player_name: r.playerName,
      kills: Number(r.kills) || 0,
      deaths: Number(r.deaths) || 0,
      headshots: Number(r.headshots) || 0,
      playtime_seconds: (Number(r.playtime) || 0) * this.playtimeFactor,
    };
  }

  async getRow(steamId) {
    const [rows] = await this.pool.execute(
      `SELECT ${this._select()} FROM ${this.table} WHERE ${this.col.steamId} = ? LIMIT 1`,
      [String(steamId)]
    );
    return rows[0] ? this._map(rows[0]) : null;
  }

  async getTop(metric, limit) {
    const order = { kills: this.col.kills, playtime: this.col.playtime, deaths: this.col.deaths }[metric];
    const n = Math.max(1, Math.min(25, Number(limit) | 0 || 10));
    const [rows] = await this.pool.query(`SELECT ${this._select()} FROM ${this.table} ORDER BY ${order} DESC LIMIT ${n}`);
    return rows.map((r) => this._map(r));
  }

  /** Zombie farmers, builders and resource gatherers (top N each). */
  async getFarm(limit) {
    const c = this.col;
    const n = Math.max(1, Math.min(10, Number(limit) | 0 || 5));
    const q = async (extra, order) => {
      const [rows] = await this.pool.query(
        `SELECT CAST(${c.steamId} AS CHAR) AS steamId, ${c.name} AS name, ${extra} FROM ${this.table} ORDER BY ${order} DESC LIMIT ${n}`
      );
      return rows;
    };
    const [farmers, builders, gatherers] = await Promise.all([
      q(`${c.zombies} AS zombies, ${c.megaZombies} AS mega`, `(${c.zombies} + ${c.megaZombies})`),
      q(`${c.structures} AS structures, ${c.barricades} AS barricades`, `(${c.structures} + ${c.barricades})`),
      q(`${c.resources} AS resources`, c.resources),
    ]);
    return { farmers, builders, gatherers };
  }

  async getKillsRank(kills) {
    const [[a]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM ${this.table}`);
    const [[b]] = await this.pool.execute(`SELECT COUNT(*) + 1 AS rnk FROM ${this.table} WHERE ${this.col.kills} > ?`, [kills]);
    return { rank: Number(b.rnk), total: Number(a.total) };
  }

  async close() {
    await this.pool.end().catch(() => {});
  }
}

class StatsService {
  /**
   * @param cacheMs how long leaderboard-style reads are reused. Many panels/commands ask for the same data, and
   * the MySQL table only changes every few minutes, so this keeps idle load near zero.
   */
  constructor({ statsRepo, mysqlConfig = null, mysqlModule = null, logger = console, cacheMs = null, now = Date.now }) {
    this.now = now;
    this.cache = new Map(); // key -> { value, expires }
    this.inflight = new Map();
    this.cacheMs = cacheMs ?? (mysqlConfig?.enabled ? 60_000 : 5_000);
    this.repo = statsRepo;
    this.logger = logger;
    this.mysql = null;
    this.mysqlFailures = 0;
    if (mysqlConfig?.enabled) {
      try {
        this.mysql = new MySqlStatsSource(mysqlConfig, mysqlModule);
      } catch (err) {
        this.logger.warn(`[stats] MySQL source disabled: ${err.message}`);
      }
    }
  }

  /** Serves a fresh cached value, joins an identical request already in flight, or computes and stores it. */
  async _cached(key, compute) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = Promise.resolve()
      .then(compute)
      .then((value) => {
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, { value, expires: this.now() + this.cacheMs });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  get source() {
    return this.mysql ? "mysql" : "sqlite";
  }

  async _viaMysql(fn, fallback) {
    if (!this.mysql) return fallback();
    try {
      const out = await fn(this.mysql);
      this.mysqlFailures = 0;
      return out;
    } catch (err) {
      if (this.mysqlFailures++ % 20 === 0) this.logger.warn(`[stats] MySQL query failed, using SQLite fallback: ${err.message}`);
      return fallback();
    }
  }

  static _shape(row) {
    if (!row) return null;
    const kills = row.kills || 0;
    const deaths = row.deaths || 0;
    return {
      steamId: row.steam_id,
      playerName: row.player_name || "Unknown",
      kills,
      deaths,
      kd: deaths === 0 ? kills : Number((kills / deaths).toFixed(2)),
      headshots: row.headshots || 0,
      playtimeSeconds: row.playtime_seconds || 0,
    };
  }

  /** @returns {Promise<object|null>} stats + `rank`/`total` (kills rank) when known */
  async getStats(steamId) {
    const sid = String(steamId).trim();
    const stats = await this._viaMysql(
      async (m) => StatsService._shape(await m.getRow(sid)),
      async () => {
        const s = this.repo.getStats(sid);
        return s && { ...s };
      }
    );
    if (!stats) return null;
    try {
      const rk = await this._viaMysql(
        (m) => m.getKillsRank(stats.kills),
        () => {
          const row = this.repo.dbManager.prepare("SELECT COUNT(*) + 1 AS rnk FROM player_stats WHERE kills > ?").get(stats.kills);
          const tot = this.repo.dbManager.prepare("SELECT COUNT(*) AS total FROM player_stats").get();
          return { rank: Number(row.rnk), total: Number(tot.total) };
        }
      );
      stats.rank = rk.rank;
      stats.total = rk.total;
    } catch {}
    return stats;
  }

  async getTop(metric, limit = 10) {
    const m = METRICS[metric] || "kills";
    return this._cached(`top:${m}:${limit}`, () => this._viaMysql(
      (src) => src.getTop(m, limit),
      () => (m === "playtime" ? this.repo.getTopPlaytime(limit) : m === "deaths" ? this.repo.getTopDeaths(limit) : this.repo.getTopKills(limit))
    ));
  }

  /** Farm/build rankings only exist in the legacy MySQL table; returns null when MySQL is not enabled. */
  async getFarmboards(limit = 5) {
    if (!this.mysql) return null;
    return this._cached(`farm:${limit}`, async () => {
      try {
        return await this.mysql.getFarm(limit);
      } catch (err) {
        this.logger.warn(`[stats] MySQL farm query failed: ${err.message}`);
        return null;
      }
    });
  }

  async getLeaderboards(limit = 10) {
    const [kills, playtime, deaths] = await Promise.all([
      this.getTop("kills", limit),
      this.getTop("playtime", limit),
      this.getTop("deaths", limit),
    ]);
    return { kills, playtime, deaths };
  }

  async close() {
    if (this.mysql) await this.mysql.close();
  }
}

module.exports = { StatsService, MySqlStatsSource };
