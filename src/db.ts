/**
 * The narrow slice of D1 this project actually uses.
 *
 * Everything below the route layer is written against `Db`, not `D1Database`.
 * That is what lets the whole app be tested against Node's built-in `node:sqlite`
 * with no Workers runtime, no miniflare pool, and no extra dependency.
 */

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): DbStatement;
}

/**
 * Schema. Every statement is idempotent, so this can run on every cold start.
 *
 * The ledger triggers are the enforcement, not a convention: SQLite itself
 * refuses UPDATE and DELETE on the ledger table. There is no code path in this
 * repo that can rewrite history, because there is no code path that could
 * succeed if it tried.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS ledger (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT    NOT NULL UNIQUE,
    ts            TEXT    NOT NULL,
    direction     TEXT    NOT NULL CHECK (direction IN ('in','out')),
    amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
    currency      TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    description   TEXT    NOT NULL,
    metadata      TEXT    NOT NULL,
    prev_hash     TEXT    NOT NULL,
    hash          TEXT    NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts)`,
  `CREATE TRIGGER IF NOT EXISTS ledger_no_update
     BEFORE UPDATE ON ledger
     BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ledger_no_delete
     BEFORE DELETE ON ledger
     BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END`,

  // `verified` records whether the edge corroborated the user-agent's claim
  // (Cloudflare's verified-bot signal), not whether the UA string said a name.
  // Anyone can type "GPTBot" into a header; only some of them can prove it.
  `CREATE TABLE IF NOT EXISTS passersby (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT    NOT NULL,
    day        TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    surface    TEXT    NOT NULL,
    ua         TEXT    NOT NULL,
    ua_family  TEXT    NOT NULL,
    paid       INTEGER NOT NULL DEFAULT 0,
    verified   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS passersby_day ON passersby (day)`,
  `CREATE TABLE IF NOT EXISTS passersby_daily (
    day           TEXT    NOT NULL,
    ua_family     TEXT    NOT NULL,
    surface       TEXT    NOT NULL,
    hits          INTEGER NOT NULL DEFAULT 0,
    paid          INTEGER NOT NULL DEFAULT 0,
    verified_hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, ua_family, surface)
  )`,

  `CREATE TABLE IF NOT EXISTS kofi_messages (
    message_id  TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    ledger_id   TEXT NOT NULL
  )`,

  // Replay protection for /alms. One row per authorization nonce ever accepted;
  // the PRIMARY KEY is the whole mechanism. Without this the same X-PAYMENT
  // header can be resubmitted forever.
  `CREATE TABLE IF NOT EXISTS x402_nonces (
    nonce     TEXT PRIMARY KEY,
    seen_at   TEXT NOT NULL,
    payer     TEXT NOT NULL,
    ledger_id TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT    NOT NULL,
    day    TEXT    NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, day)
  )`,

  `CREATE TABLE IF NOT EXISTS outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    day        TEXT NOT NULL,
    channel    TEXT NOT NULL,
    body       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'unsent',
    UNIQUE (day, channel)
  )`,

  `CREATE TABLE IF NOT EXISTS performances (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    subject     TEXT NOT NULL,
    output      TEXT,
    status      TEXT NOT NULL DEFAULT 'queued'
  )`,

  `CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/**
 * Additive column migrations for databases created before a column existed.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so these are expected to fail with
 * "duplicate column name" on every run after the first, and that failure is
 * swallowed. Only ever put additive, defaulted columns here — anything that
 * needs a table rebuild belongs in a real migration file, not a try/catch.
 */
export const MIGRATION_STATEMENTS: string[] = [
  `ALTER TABLE passersby ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE passersby_daily ADD COLUMN verified_hits INTEGER NOT NULL DEFAULT 0`,
];

let ensured = false;

/** Idempotent. Runs once per isolate; the statements are safe to re-run anyway. */
export async function ensureSchema(db: Db, force = false): Promise<void> {
  if (ensured && !force) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
  }
  for (const sql of MIGRATION_STATEMENTS) {
    try {
      await db.prepare(sql).run();
    } catch {
      // Already applied. See the note on MIGRATION_STATEMENTS.
    }
  }
  ensured = true;
}

/** Test seam: forget that the schema was applied. */
export function resetSchemaCache(): void {
  ensured = false;
}

export async function getState(db: Db, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM state WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(db: Db, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}
