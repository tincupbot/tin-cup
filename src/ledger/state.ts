import type { Db } from "../db.ts";
import { getState, setState } from "../db.ts";
import { GENESIS_PREV_HASH } from "./hash.ts";

/**
 * The materialised summary of the ledger.
 *
 * Before this existed, rendering the homepage was O(the whole database): a full
 * scan to sum the balance, a second full scan plus a SHA-256 per row to verify
 * the chain, a third to build the patron wall. Fine at a hundred entries, a
 * self-inflicted outage the day the front page arrives.
 *
 * So the append path maintains a single JSON row in `state` holding everything
 * the front page needs, and reads come out of that. The safety property that
 * makes this acceptable for a project whose entire credibility is its books:
 *
 *   every read cross-checks the summary against the actual chain tip, which is
 *   one indexed row lookup, and rebuilds from scratch the moment they disagree.
 *
 * So a write path that forgets to update the summary — a migration, a manual
 * INSERT, a future bug — is *detected* rather than quietly published. The
 * summary is a cache, the ledger is the truth, and the ledger wins.
 */

export const LEDGER_STATE_KEY = "ledger_summary";

export type LedgerState = {
  /** seq of the last entry. 0 when empty. */
  seq: number;
  /** hash of the last entry, or the genesis prev-hash when empty. */
  head: string;
  entries: number;
  total_in_micros: number;
  total_out_micros: number;
  first_ts: string | null;
  /** True once any seeded demo entry exists. Drives the fixture banner for free. */
  has_fixture: boolean;
};

export const EMPTY_STATE: LedgerState = {
  seq: 0,
  head: GENESIS_PREV_HASH,
  entries: 0,
  total_in_micros: 0,
  total_out_micros: 0,
  first_ts: null,
  has_fixture: false,
};

type Tip = { seq: number; hash: string } | null;

async function readTip(db: Db): Promise<Tip> {
  // O(1): seq is the INTEGER PRIMARY KEY, so this is a single index seek.
  return db.prepare(`SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1`).first<{ seq: number; hash: string }>();
}

/** Recompute the summary from the ledger. One full aggregate scan; called rarely. */
export async function rebuildLedgerState(db: Db): Promise<LedgerState> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS entries,
         COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount_micros ELSE 0 END), 0) AS total_in,
         COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_micros ELSE 0 END), 0) AS total_out,
         MIN(ts) AS first_ts,
         COALESCE(MAX(CASE WHEN kind = 'dev_fixture'
                             OR json_extract(metadata, '$.fixture') = 1
                           THEN 1 ELSE 0 END), 0) AS has_fixture
       FROM ledger`,
    )
    .first<{ entries: number; total_in: number; total_out: number; first_ts: string | null; has_fixture: number }>();

  const tip = await readTip(db);

  const state: LedgerState = {
    seq: tip?.seq ?? 0,
    head: tip?.hash ?? GENESIS_PREV_HASH,
    entries: row?.entries ?? 0,
    total_in_micros: row?.total_in ?? 0,
    total_out_micros: row?.total_out ?? 0,
    first_ts: row?.first_ts ?? null,
    has_fixture: Boolean(row?.has_fixture),
  };

  await writeLedgerState(db, state);
  return state;
}

export async function writeLedgerState(db: Db, state: LedgerState): Promise<void> {
  await setState(db, LEDGER_STATE_KEY, JSON.stringify(state));
}

/**
 * The summary, checked against the chain tip and rebuilt if it has drifted.
 *
 * Normal cost: one `state` row read plus one indexed tip lookup. No scan.
 */
export async function readLedgerState(db: Db): Promise<LedgerState> {
  const raw = await getState(db, LEDGER_STATE_KEY);
  const tip = await readTip(db);

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LedgerState;
      const tipSeq = tip?.seq ?? 0;
      const tipHash = tip?.hash ?? GENESIS_PREV_HASH;
      if (parsed.seq === tipSeq && parsed.head === tipHash) return parsed;
    } catch {
      // Unparseable summary is the same problem as a stale one, and has the
      // same fix. Fall through to the rebuild.
    }
  }

  return rebuildLedgerState(db);
}
