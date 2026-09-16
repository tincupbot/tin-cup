-- Tin Cup, initial schema.
--
-- This file is the schema. It used to be thirteen idempotent CREATE statements
-- executed on the request path, once per cold isolate, on the way to rendering
-- a page — which is both a waste and a way for DDL to run under load. It is now
-- applied out of band:
--
--   npm run db:migrate          (local miniflare D1)
--   wrangler d1 migrations apply tincup --remote     (never run; needs Ben)
--
-- The tests and the dev seeder execute this same file against node:sqlite, so
-- there is exactly one definition of the schema and no second copy to drift.

-- ---------------------------------------------------------------------------
-- The ledger. The only thing here that must never be wrong.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ledger (
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
);

CREATE INDEX IF NOT EXISTS ledger_ts ON ledger (ts);

-- The burn window and the day's spend are both `WHERE direction=? AND ts>=?`,
-- and the patron wall is `WHERE direction='in' AND kind IN (...)`. Without
-- these two the front page reads the whole table for every visitor.
CREATE INDEX IF NOT EXISTS ledger_kind_ts ON ledger (kind, ts);
CREATE INDEX IF NOT EXISTS ledger_direction_ts ON ledger (direction, ts);

-- The enforcement, not a convention: SQLite itself refuses to rewrite history.
-- There is no code path in this repo that could edit a ledger row, because
-- there is no code path that would succeed if it tried.
CREATE TRIGGER IF NOT EXISTS ledger_no_update
  BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
  BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

-- ---------------------------------------------------------------------------
-- Passers-by.
-- ---------------------------------------------------------------------------

-- `verified` records whether the edge corroborated the user-agent's claim
-- (Cloudflare's verified-bot signal), not whether the UA string said a name.
-- Anyone can type "GPTBot" into a header; only some of them can prove it.
--
-- This is now a SAMPLED log, kept as evidence rather than as the counter. The
-- counters come from passersby_daily and passersby_agents below.
CREATE TABLE IF NOT EXISTS passersby (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  surface    TEXT    NOT NULL,
  ua         TEXT    NOT NULL,
  ua_family  TEXT    NOT NULL,
  paid       INTEGER NOT NULL DEFAULT 0,
  verified   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS passersby_day ON passersby (day);
CREATE INDEX IF NOT EXISTS passersby_day_ua ON passersby (day, ua);

CREATE TABLE IF NOT EXISTS passersby_daily (
  day           TEXT    NOT NULL,
  ua_family     TEXT    NOT NULL,
  surface       TEXT    NOT NULL,
  hits          INTEGER NOT NULL DEFAULT 0,
  paid          INTEGER NOT NULL DEFAULT 0,
  verified_hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ua_family, surface)
);

-- One row per distinct agent per day, claimed with INSERT OR IGNORE.
--
-- This replaces `COUNT(DISTINCT ua)` over the unbounded raw log, which was a
-- full scan of every request ever made, run twice per homepage render, on a
-- column with no index. Bounded by (days x distinct agents), which is the
-- number we actually wanted to count in the first place.
CREATE TABLE IF NOT EXISTS passersby_agents (
  day       TEXT NOT NULL,
  ua        TEXT NOT NULL,
  ua_family TEXT NOT NULL,
  first_ts  TEXT NOT NULL,
  PRIMARY KEY (day, ua)
);

-- ---------------------------------------------------------------------------
-- Money claims arriving from outside.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kofi_messages (
  message_id  TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  ledger_id   TEXT NOT NULL
);

-- Replay protection for /alms. One row per authorization nonce ever accepted;
-- the PRIMARY KEY is the whole mechanism. Without this the same X-PAYMENT
-- header can be resubmitted forever.
CREATE TABLE IF NOT EXISTS x402_nonces (
  nonce     TEXT PRIMARY KEY,
  seen_at   TEXT NOT NULL,
  payer     TEXT NOT NULL,
  ledger_id TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Operational.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, day)
);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  day        TEXT NOT NULL,
  channel    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'unsent',
  UNIQUE (day, channel)
);

CREATE TABLE IF NOT EXISTS performances (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  output      TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per life and per return, claimed before the ledger marker is written.
-- Two concurrent reconciles used to be able to write two death markers for one
-- death; the PRIMARY KEY is what makes that impossible rather than unlikely.
CREATE TABLE IF NOT EXISTS lifecycle_events (
  event           TEXT    NOT NULL,
  lifetime_number INTEGER NOT NULL,
  at              TEXT    NOT NULL,
  PRIMARY KEY (event, lifetime_number)
);
