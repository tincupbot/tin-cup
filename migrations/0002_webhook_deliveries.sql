-- A durable record of every money-shaped thing that knocked on the door.
--
-- WHY THIS EXISTS, written on the day it was needed:
--
-- 2026-09-21. The operator clicked Ko-fi's "Send Test" button and asked what
-- arrived. The honest answer was: no idea. A delivery that is deliberately not
-- written to the ledger — a Ko-fi test send, a dry run, a payload rejected for
-- a bad token or the wrong currency — left exactly one trace, a `console.log`
-- visible only to whoever happened to be attached with `wrangler tail` at that
-- second. Nobody was. The raw passers-by log samples one request in ten, so it
-- could neither confirm nor deny the hit.
--
-- That made "did the webhook work?" a question you could only answer by
-- standing next to it, and it meant a delivery that never came and a delivery
-- that was refused looked identical from the outside. On a project whose whole
-- claim is that its numbers can be checked, the events it decides *not* to
-- count are exactly the ones that need to stay visible. Silence is not
-- evidence of anything.
--
-- So: one row per delivery, every outcome, booked or not.
--
-- WHAT IS DELIBERATELY NOT STORED HERE. No verification token, ever — not even
-- a rejected one, because a near-miss is still most of a secret. No supporter
-- email, no supporter message, no name. The columns below are the operational
-- facts (did it arrive, was it accepted, how much did it claim, in what
-- currency) and nothing about a person.
--
-- This table is not the books and must never be read as them. It records
-- claims; `ledger` records money. The `ledger_id` column is the join between
-- the two and is NULL for every row that was not booked — which is the point.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  -- booked | duplicate | test_payment | dry_run | rejected
  outcome     TEXT    NOT NULL,
  -- Why, in words, for the outcomes that need one. NULL when self-evident.
  reason      TEXT,
  http_status INTEGER NOT NULL,
  -- What the payload claimed, which is not the same as what was credited.
  -- NULL when the payload was too broken to say.
  amount_micros INTEGER,
  currency    TEXT,
  event_type  TEXT,
  -- Set only when this delivery became a line in the books.
  ledger_id   TEXT
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_ts ON webhook_deliveries (ts);
