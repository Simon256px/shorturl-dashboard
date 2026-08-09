/**
 * Storage layer — SQLite via Deno's built-in `node:sqlite` (no native module to
 * compile, no service to run, one file to back up).
 *
 * Design notes:
 *  - WAL mode: readers never block the redirect path while a write is in flight.
 *  - Click writes are queued in memory and flushed in batches. A redirect must
 *    not wait on fsync; losing at most one batch on a hard kill is an
 *    acceptable trade for analytics data.
 *  - `links.click_count` is denormalised so the dashboard list never has to
 *    COUNT(*) over the whole click table.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export interface LinkRow {
  id: number;
  slug: string;
  target: string;
  note: string | null;
  created_at: number;
  expires_at: number | null;
  disabled: number;
  click_count: number;
  last_click_at: number | null;
  /** Open Graph overrides. All null means "let the destination's card show". */
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  /** Declared publication channel (a `Channel.id`), or null for unattributed. */
  channel: string | null;
}

/** One row of the per-channel breakdown. `channel` is null for unattributed. */
export interface ChannelStat {
  channel: string | null;
  links: number;
  /** Lifetime clicks, from the denormalised counter — survives retention. */
  clicks: number;
  /** Clicks inside the requested window, from retained click rows. */
  recent: number;
  visitors: number;
}

/** True when a link carries enough Open Graph data to be worth rendering. */
export function hasOpenGraph(link: LinkRow): boolean {
  return Boolean(link.og_title || link.og_description || link.og_image);
}

export interface ClickInsert {
  link_id: number;
  ts: number;
  visitor: string;
  referrer_host: string | null;
  country: string | null;
  browser: string;
  os: string;
  device: string;
  lang: string | null;
}

export interface Bucket {
  label: string;
  value: number;
}

/** Bump alongside a new entry in MIGRATIONS. Exported so tests can assert a
 * fresh database lands on the latest version without hard-coding a number. */
export const SCHEMA_VERSION = 3;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE links (
    id            INTEGER PRIMARY KEY,
    slug          TEXT    NOT NULL UNIQUE,
    target        TEXT    NOT NULL,
    note          TEXT,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    disabled      INTEGER NOT NULL DEFAULT 0,
    click_count   INTEGER NOT NULL DEFAULT 0,
    last_click_at INTEGER
  );
  CREATE INDEX idx_links_created ON links(created_at DESC);
  CREATE INDEX idx_links_clicks  ON links(click_count DESC);

  CREATE TABLE clicks (
    id            INTEGER PRIMARY KEY,
    link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    ts            INTEGER NOT NULL,
    visitor       TEXT    NOT NULL,
    referrer_host TEXT,
    country       TEXT,
    browser       TEXT,
    os            TEXT,
    device        TEXT,
    lang          TEXT
  );
  CREATE INDEX idx_clicks_link_ts ON clicks(link_id, ts DESC);
  CREATE INDEX idx_clicks_ts      ON clicks(ts DESC);

  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    label      TEXT
  );
  CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    key_hash     TEXT    NOT NULL UNIQUE,
    prefix       TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE salts (
    day  TEXT PRIMARY KEY,
    salt TEXT NOT NULL
  );

  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // v2 — per-link Open Graph card. Nullable throughout: a link with no values
  // keeps the plain 302 behaviour, so upgrading changes nothing on its own.
  `
  ALTER TABLE links ADD COLUMN og_title       TEXT;
  ALTER TABLE links ADD COLUMN og_description TEXT;
  ALTER TABLE links ADD COLUMN og_image       TEXT;
  `,

  // v3 — declared publication channel. Nullable, and null is a first-class
  // state rather than a gap to fill: existing links keep behaving exactly as
  // they did, they simply report as unattributed.
  `
  ALTER TABLE links ADD COLUMN channel TEXT;
  CREATE INDEX idx_links_channel ON links(channel);
  `,
];

export function utcDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class Store {
  #db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  #queue: ClickInsert[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // Order matters: WAL before any write, foreign_keys before any DELETE.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA temp_store = MEMORY");
    this.#migrate();
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
    let version = Number(row.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${version} is newer than this build (v${SCHEMA_VERSION}). ` +
          "Refusing to start rather than corrupt it.",
      );
    }
    while (version < SCHEMA_VERSION) {
      const sql = MIGRATIONS[version];
      if (!sql) throw new Error(`Missing migration for version ${version + 1}`);
      this.#db.exec("BEGIN");
      try {
        this.#db.exec(sql);
        version++;
        this.#db.exec(`PRAGMA user_version = ${version}`);
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  /** Prepared statements are reused; re-preparing on every request is wasteful. */
  #s(sql: string): StatementSync {
    let st = this.#stmts.get(sql);
    if (!st) {
      st = this.#db.prepare(sql);
      this.#stmts.set(sql, st);
    }
    return st;
  }

  // --- Links ---------------------------------------------------------------

  getLinkBySlug(slug: string): LinkRow | undefined {
    return this.#s("SELECT * FROM links WHERE slug = ?").get(slug) as LinkRow | undefined;
  }

  getLinkById(id: number): LinkRow | undefined {
    return this.#s("SELECT * FROM links WHERE id = ?").get(id) as LinkRow | undefined;
  }

  createLink(input: {
    slug: string;
    target: string;
    note: string | null;
    expiresAt: number | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImage?: string | null;
    channel?: string | null;
  }): LinkRow {
    const now = Math.floor(Date.now() / 1000);
    this.#s(
      `INSERT INTO links (slug, target, note, created_at, expires_at,
                          og_title, og_description, og_image, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.slug,
      input.target,
      input.note,
      now,
      input.expiresAt,
      input.ogTitle ?? null,
      input.ogDescription ?? null,
      input.ogImage ?? null,
      input.channel ?? null,
    );
    return this.getLinkBySlug(input.slug)!;
  }

  updateLink(
    id: number,
    patch: {
      target?: string;
      note?: string | null;
      expiresAt?: number | null;
      disabled?: boolean;
      ogTitle?: string | null;
      ogDescription?: string | null;
      ogImage?: string | null;
      channel?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (patch.target !== undefined) {
      sets.push("target = ?");
      args.push(patch.target);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      args.push(patch.note);
    }
    if (patch.ogTitle !== undefined) {
      sets.push("og_title = ?");
      args.push(patch.ogTitle);
    }
    if (patch.ogDescription !== undefined) {
      sets.push("og_description = ?");
      args.push(patch.ogDescription);
    }
    if (patch.ogImage !== undefined) {
      sets.push("og_image = ?");
      args.push(patch.ogImage);
    }
    if (patch.channel !== undefined) {
      sets.push("channel = ?");
      args.push(patch.channel);
    }
    if (patch.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      args.push(patch.expiresAt);
    }
    if (patch.disabled !== undefined) {
      sets.push("disabled = ?");
      args.push(patch.disabled ? 1 : 0);
    }
    if (sets.length === 0) return;
    args.push(id);
    this.#s(`UPDATE links SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  deleteLink(id: number): void {
    // Drop queued clicks for this link first: flushing them after the DELETE
    // would fail the foreign key and take the whole batch down with it.
    this.#queue = this.#queue.filter((c) => c.link_id !== id);
    this.#s("DELETE FROM links WHERE id = ?").run(id);
  }

  /**
   * Shared WHERE for the list and its count, so a filter can never apply to one
   * and not the other — that mismatch shows up as a pager that runs off the end.
   *
   * `channel: "none"` selects the unattributed links. It has to be a magic value
   * because an absent filter and "filter for NULL" are different requests and an
   * empty string cannot express both.
   */
  #linkFilter(search?: string, channel?: string): { sql: string; args: string[] } {
    const where: string[] = [];
    const args: string[] = [];
    if (search) {
      const like = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
      where.push(
        `(slug LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')`,
      );
      args.push(like, like, like);
    }
    if (channel === "none") {
      where.push("channel IS NULL");
    } else if (channel) {
      where.push("channel = ?");
      args.push(channel);
    }
    return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
  }

  listLinks(
    opts: { limit: number; offset: number; search?: string; sort?: string; channel?: string },
  ): LinkRow[] {
    const order = opts.sort === "clicks"
      ? "click_count DESC, created_at DESC"
      : opts.sort === "oldest"
      ? "created_at ASC"
      : "created_at DESC";

    const f = this.#linkFilter(opts.search, opts.channel);
    return this.#s(
      `SELECT * FROM links${f.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).all(...f.args, opts.limit, opts.offset) as unknown as LinkRow[];
  }

  countLinks(search?: string, channel?: string): number {
    const f = this.#linkFilter(search, channel);
    const r = this.#s(`SELECT COUNT(*) AS n FROM links${f.sql}`).get(...f.args) as { n: number };
    return Number(r.n);
  }

  /**
   * Per-channel breakdown, in two queries deliberately.
   *
   * Lifetime clicks come from `links.click_count` and the windowed figures from
   * the `clicks` rows. Doing both in one LEFT JOIN would multiply each link's
   * counter by its number of clicks in the window — a plausible-looking total
   * that is simply wrong. Merging two honest queries in TypeScript is cheaper
   * than the SQL that avoids the fan-out.
   */
  channelStats(sinceSeconds: number): ChannelStat[] {
    const base = this.#s(
      `SELECT channel, COUNT(*) AS links, COALESCE(SUM(click_count), 0) AS clicks
       FROM links GROUP BY channel`,
    ).all() as unknown as Array<{ channel: string | null; links: number; clicks: number }>;

    const windowed = this.#s(
      `SELECT l.channel AS channel, COUNT(*) AS recent, COUNT(DISTINCT c.visitor) AS visitors
       FROM clicks c JOIN links l ON l.id = c.link_id
       WHERE c.ts >= ? GROUP BY l.channel`,
    ).all(Math.floor(Date.now() / 1000) - sinceSeconds) as unknown as Array<
      { channel: string | null; recent: number; visitors: number }
    >;

    const recent = new Map(windowed.map((r) => [r.channel, r]));
    return base
      .map((row) => ({
        channel: row.channel,
        links: Number(row.links),
        clicks: Number(row.clicks),
        recent: Number(recent.get(row.channel)?.recent ?? 0),
        visitors: Number(recent.get(row.channel)?.visitors ?? 0),
      }))
      .sort((a, b) => b.recent - a.recent || b.clicks - a.clicks || b.links - a.links);
  }

  slugExists(slug: string): boolean {
    return this.#s("SELECT 1 AS x FROM links WHERE slug = ?").get(slug) !== undefined;
  }

  // --- Clicks --------------------------------------------------------------

  /**
   * Queue a click. Returns immediately — the redirect is already on its way and
   * has no business waiting for a disk write.
   */
  recordClick(click: ClickInsert): void {
    if (this.#closed) return;
    this.#queue.push(click);
    // A burst shouldn't sit in memory until the timer fires.
    if (this.#queue.length >= 256) {
      this.flushClicks();
      return;
    }
    if (this.#flushTimer === undefined) {
      const timer = setTimeout(() => this.flushClicks(), 500);
      this.#flushTimer = timer;
      Deno.unrefTimer(timer);
    }
  }

  flushClicks(): number {
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#queue.length === 0) return 0;

    const batch = this.#queue;
    this.#queue = [];

    const insert = this.#s(
      `INSERT INTO clicks (link_id, ts, visitor, referrer_host, country, browser, os, device, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const bump = this.#s(
      "UPDATE links SET click_count = click_count + 1, last_click_at = ? WHERE id = ?",
    );

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of batch) {
        insert.run(
          c.link_id,
          c.ts,
          c.visitor,
          c.referrer_host,
          c.country,
          c.browser,
          c.os,
          c.device,
          c.lang,
        );
        bump.run(c.ts, c.link_id);
      }
      this.#db.exec("COMMIT");
      return batch.length;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      // Analytics are best-effort: log and move on rather than take the
      // redirect service down over a stats write.
      console.error("[db] click flush failed, dropping batch:", err);
      return 0;
    }
  }

  // --- Statistics ----------------------------------------------------------

  /**
   * Note the asymmetry: `clicks` comes from the lifetime counter on `links`
   * and survives retention purges, while `visitors` is a DISTINCT over the
   * `clicks` table and therefore only covers the retention window. Counting
   * lifetime uniques would mean keeping the per-click rows forever, which is
   * exactly what the retention policy exists to avoid.
   */
  globalTotals(): { links: number; clicks: number; visitors: number; active: number } {
    const r = this.#s(
      `SELECT (SELECT COUNT(*) FROM links)                                    AS links,
              (SELECT COALESCE(SUM(click_count), 0) FROM links)               AS clicks,
              (SELECT COUNT(DISTINCT visitor) FROM clicks)                    AS visitors,
              (SELECT COUNT(*) FROM links WHERE disabled = 0
                 AND (expires_at IS NULL OR expires_at > unixepoch()))        AS active`,
    ).get() as Record<string, number>;
    return {
      links: Number(r.links),
      clicks: Number(r.clicks),
      visitors: Number(r.visitors),
      active: Number(r.active),
    };
  }

  clicksSince(seconds: number, linkId?: number): { clicks: number; visitors: number } {
    const since = Math.floor(Date.now() / 1000) - seconds;
    const r = linkId === undefined
      ? this.#s(
        "SELECT COUNT(*) AS c, COUNT(DISTINCT visitor) AS v FROM clicks WHERE ts >= ?",
      ).get(since)
      : this.#s(
        "SELECT COUNT(*) AS c, COUNT(DISTINCT visitor) AS v FROM clicks WHERE ts >= ? AND link_id = ?",
      ).get(since, linkId);
    const row = r as { c: number; v: number };
    return { clicks: Number(row.c), visitors: Number(row.v) };
  }

  /** Clicks per UTC day for the last `days` days, oldest first, gaps filled. */
  dailySeries(days: number, linkId?: number): Bucket[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const startDay = Math.floor(nowSec / 86400) - (days - 1);
    const since = startDay * 86400;

    const rows = (linkId === undefined
      ? this.#s(
        "SELECT ts / 86400 AS d, COUNT(*) AS n FROM clicks WHERE ts >= ? GROUP BY d",
      ).all(since)
      : this.#s(
        "SELECT ts / 86400 AS d, COUNT(*) AS n FROM clicks WHERE ts >= ? AND link_id = ? GROUP BY d",
      ).all(since, linkId)) as Array<{ d: number; n: number }>;

    const byDay = new Map<number, number>();
    for (const r of rows) byDay.set(Number(r.d), Number(r.n));

    const out: Bucket[] = [];
    for (let d = startDay; d <= Math.floor(nowSec / 86400); d++) {
      out.push({
        label: new Date(d * 86400_000).toISOString().slice(0, 10),
        value: byDay.get(d) ?? 0,
      });
    }
    return out;
  }

  /** Clicks per hour for the last `hours` hours, oldest first, gaps filled. */
  hourlySeries(hours: number, linkId?: number): Bucket[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const startHour = Math.floor(nowSec / 3600) - (hours - 1);
    const since = startHour * 3600;

    const rows =
      (linkId === undefined
        ? this.#s("SELECT ts / 3600 AS h, COUNT(*) AS n FROM clicks WHERE ts >= ? GROUP BY h")
          .all(since)
        : this.#s(
          "SELECT ts / 3600 AS h, COUNT(*) AS n FROM clicks WHERE ts >= ? AND link_id = ? GROUP BY h",
        ).all(since, linkId)) as Array<{ h: number; n: number }>;

    const byHour = new Map<number, number>();
    for (const r of rows) byHour.set(Number(r.h), Number(r.n));

    const out: Bucket[] = [];
    for (let h = startHour; h <= Math.floor(nowSec / 3600); h++) {
      out.push({
        label: new Date(h * 3600_000).toISOString().slice(11, 13) + "h",
        value: byHour.get(h) ?? 0,
      });
    }
    return out;
  }

  /**
   * Top values of a dimension. The column name is not user input — it is picked
   * from this fixed map, because it cannot be bound as a parameter.
   */
  topDimension(
    dimension: "referrer_host" | "country" | "browser" | "os" | "device" | "lang",
    opts: { limit?: number; linkId?: number; sinceSeconds?: number } = {},
  ): Bucket[] {
    const allowed = ["referrer_host", "country", "browser", "os", "device", "lang"];
    if (!allowed.includes(dimension)) throw new Error(`Unknown dimension ${dimension}`);

    const limit = opts.limit ?? 10;
    const where: string[] = [`${dimension} IS NOT NULL`, `${dimension} != ''`];
    const args: number[] = [];
    if (opts.sinceSeconds !== undefined) {
      where.push("ts >= ?");
      args.push(Math.floor(Date.now() / 1000) - opts.sinceSeconds);
    }
    if (opts.linkId !== undefined) {
      where.push("link_id = ?");
      args.push(opts.linkId);
    }

    const rows = this.#s(
      `SELECT ${dimension} AS label, COUNT(*) AS n FROM clicks
       WHERE ${where.join(" AND ")}
       GROUP BY ${dimension} ORDER BY n DESC LIMIT ?`,
    ).all(...args, limit) as Array<{ label: string; n: number }>;

    return rows.map((r) => ({ label: String(r.label), value: Number(r.n) }));
  }

  topLinks(limit = 10, sinceSeconds?: number): Array<LinkRow & { recent: number }> {
    if (sinceSeconds === undefined) {
      const rows = this.#s(
        "SELECT *, click_count AS recent FROM links ORDER BY click_count DESC, created_at DESC LIMIT ?",
      ).all(limit);
      return rows as unknown as Array<LinkRow & { recent: number }>;
    }
    const since = Math.floor(Date.now() / 1000) - sinceSeconds;
    const rows = this.#s(
      `SELECT l.*, COUNT(c.id) AS recent
       FROM links l JOIN clicks c ON c.link_id = l.id AND c.ts >= ?
       GROUP BY l.id ORDER BY recent DESC LIMIT ?`,
    ).all(since, limit);
    return rows as unknown as Array<LinkRow & { recent: number }>;
  }

  /** Raw click rows for CSV export. Bounded so an export can't exhaust memory. */
  exportClicks(linkId: number | undefined, limit = 100_000): Array<Record<string, unknown>> {
    return (linkId === undefined
      ? this.#s(
        `SELECT c.ts, l.slug, c.referrer_host, c.country, c.browser, c.os, c.device, c.lang
         FROM clicks c JOIN links l ON l.id = c.link_id ORDER BY c.ts DESC LIMIT ?`,
      ).all(limit)
      : this.#s(
        `SELECT c.ts, l.slug, c.referrer_host, c.country, c.browser, c.os, c.device, c.lang
         FROM clicks c JOIN links l ON l.id = c.link_id WHERE c.link_id = ?
         ORDER BY c.ts DESC LIMIT ?`,
      ).all(linkId, limit)) as Array<Record<string, unknown>>;
  }

  // --- Sessions ------------------------------------------------------------

  createSession(tokenHash: string, ttlSeconds: number, label: string | null): void {
    const now = Math.floor(Date.now() / 1000);
    this.#s(
      "INSERT INTO sessions (token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)",
    ).run(tokenHash, now, now + ttlSeconds, label);
  }

  getSession(tokenHash: string): { expires_at: number } | undefined {
    return this.#s(
      "SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > unixepoch()",
    ).get(tokenHash) as { expires_at: number } | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.#s("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Used when the admin password changes — every existing session must die. */
  deleteAllSessions(): void {
    this.#s("DELETE FROM sessions").run();
  }

  // --- API keys ------------------------------------------------------------

  createApiKey(name: string, keyHash: string, prefix: string): void {
    this.#s(
      "INSERT INTO api_keys (name, key_hash, prefix, created_at) VALUES (?, ?, ?, unixepoch())",
    ).run(name, keyHash, prefix);
  }

  findApiKey(keyHash: string): { id: number; name: string } | undefined {
    return this.#s("SELECT id, name FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | { id: number; name: string }
      | undefined;
  }

  touchApiKey(id: number): void {
    this.#s("UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?").run(id);
  }

  listApiKeys(): Array<
    { id: number; name: string; prefix: string; created_at: number; last_used_at: number | null }
  > {
    return this.#s("SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY id")
      .all() as Array<
        {
          id: number;
          name: string;
          prefix: string;
          created_at: number;
          last_used_at: number | null;
        }
      >;
  }

  deleteApiKey(id: number): void {
    this.#s("DELETE FROM api_keys WHERE id = ?").run(id);
  }

  // --- Daily salt ----------------------------------------------------------

  /** Returns today's salt, creating it on first use. */
  dailySalt(day = utcDay()): string {
    const row = this.#s("SELECT salt FROM salts WHERE day = ?").get(day) as
      | { salt: string }
      | undefined;
    if (row) return row.salt;
    const salt = randomBytes(32).toString("base64");
    this.#s("INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)").run(day, salt);
    return (this.#s("SELECT salt FROM salts WHERE day = ?").get(day) as { salt: string }).salt;
  }

  // --- Key/value -----------------------------------------------------------

  kvGet(key: string): string | undefined {
    const r = this.#s("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return r?.value;
  }

  kvSet(key: string, value: string): void {
    this.#s(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value);
  }

  kvDelete(key: string): void {
    this.#s("DELETE FROM kv WHERE key = ?").run(key);
  }

  // --- Maintenance ---------------------------------------------------------

  /**
   * Purge expired sessions, stale salts and out-of-retention clicks.
   * Keeping two days of salts covers the UTC-midnight boundary.
   */
  maintenance(retentionDays: number): { clicks: number; sessions: number; salts: number } {
    const sessions = Number(
      this.#s("DELETE FROM sessions WHERE expires_at <= unixepoch()").run().changes,
    );
    const keep = [utcDay(), utcDay(Date.now() - 86400_000)];
    const salts = Number(
      this.#s("DELETE FROM salts WHERE day NOT IN (?, ?)").run(keep[0]!, keep[1]!).changes,
    );
    let clicks = 0;
    if (retentionDays > 0) {
      const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
      clicks = Number(this.#s("DELETE FROM clicks WHERE ts < ?").run(cutoff).changes);
    }
    if (clicks > 0) this.#db.exec("PRAGMA incremental_vacuum");
    return { clicks, sessions, salts };
  }

  /** Online backup to a second file. Safe to run while serving traffic. */
  checkpoint(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.#closed) return;
    this.flushClicks();
    this.#closed = true;
    if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
    this.#stmts.clear();
    this.#db.close();
  }

  /** Escape hatch for tests. */
  get raw(): DatabaseSync {
    return this.#db;
  }
}
