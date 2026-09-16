import type { Db } from "../db.ts";
import { GENESIS_PREV_HASH, entryHash, hashPreimage } from "./hash.ts";
import { readLedgerState, writeLedgerState, rebuildLedgerState, type LedgerState } from "./state.ts";

/**
 * Money in. `dev_fixture` is the seeded-demo kind and never means real money —
 * see scripts/seed-dev.ts. `resurrection` and `death` are zero-amount markers:
 * they carry no value but they are events the books should record, and putting
 * them in the chain is cheaper and more honest than a second, unhashed event log.
 */
export const IN_KINDS = [
  "donation",
  "startup_capital",
  "x402_alms",
  "alms_offer",
  "commission",
  "resurrection",
  "death",
  "dev_fixture",
] as const;

/** Money out. */
export const OUT_KINDS = ["inference", "hosting", "domain", "fee"] as const;

export type InKind = (typeof IN_KINDS)[number];
export type OutKind = (typeof OUT_KINDS)[number];
export type EntryKind = InKind | OutKind;

/**
 * Kinds that record an event rather than a movement of money. Always zero-amount,
 * enforced in `append`, so they cannot affect the balance however they are written.
 *
 * `alms_offer` is here for a specific reason. An x402 payload that we have not
 * verified a signature on is a stranger's unaudited claim. Recording it as money
 * would let anyone with curl move the death clock, which would make the one
 * number this project exists to publish a number anyone can choose. So it is
 * recorded as an event with the offered amount in metadata, and contributes zero.
 * When real settlement lands, that path appends `x402_alms` with a real amount.
 */
export const MARKER_KINDS: readonly EntryKind[] = ["resurrection", "death", "alms_offer"];

export type LedgerEntry = {
  seq: number;
  id: string;
  ts: string;
  direction: "in" | "out";
  amount_micros: number;
  currency: string;
  kind: EntryKind;
  description: string;
  metadata: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export type NewEntry = {
  direction: "in" | "out";
  amount_micros: number;
  kind: EntryKind;
  description: string;
  metadata?: Record<string, unknown>;
  currency?: string;
  /** Overrides only for seeding and tests. Live code lets these default. */
  id?: string;
  ts?: string;
};

type LedgerRow = Omit<LedgerEntry, "metadata"> & { metadata: string };

function rowToEntry(row: LedgerRow): LedgerEntry {
  return { ...row, metadata: JSON.parse(row.metadata) as Record<string, unknown> };
}

export class AppendOnlyViolation extends Error {}

/** Raised when an append kept losing the race for the chain tip. */
export class LedgerContentionError extends Error {
  constructor(readonly attempts: number) {
    super(`ledger append lost the race for the chain tip ${attempts} times`);
    this.name = "LedgerContentionError";
  }
}

/**
 * How many times an append will re-read the tip and try again.
 *
 * Five is generous. Each retry only loses if another writer committed in the
 * microseconds between our tip read and our insert, and D1 serialises writes,
 * so losing five in a row means something other than contention is wrong and
 * failing loudly is the correct outcome.
 */
export const APPEND_MAX_ATTEMPTS = 5;

/**
 * The UNIQUE index on `hash` is what turns a concurrent append into a loud
 * failure instead of a silent fork, so its error message is load-bearing.
 * SQLite and D1 both say "UNIQUE constraint failed: ledger.hash".
 *
 * Deliberately narrow: a collision on `ledger.id` means a caller passed an id
 * that already exists, which retrying would never fix and which must surface.
 */
function isTipRace(err: unknown): boolean {
  return /UNIQUE constraint failed:\s*ledger\.hash/i.test(String((err as Error)?.message ?? err));
}

/**
 * Append one entry. This is the only write path to the ledger in the codebase.
 *
 * Two writers can read the same chain tip; the UNIQUE index on `hash` means the
 * loser's insert is refused rather than forking the chain. Before the retry
 * below existed, nothing caught that — so a donation arriving during an
 * inference write returned a 500 and a *money event was dropped*. That is the
 * worst failure this project has: not a wrong number, a missing one.
 *
 * The loser now re-reads the tip and tries again. Nothing else changes — same
 * id, same timestamp, same metadata — so a retry produces the same entry in a
 * different place in the chain, which is exactly what losing the race means.
 */
export async function append(db: Db, entry: NewEntry): Promise<LedgerEntry> {
  if (!Number.isInteger(entry.amount_micros) || entry.amount_micros < 0) {
    throw new Error(`amount_micros must be a non-negative integer, got ${entry.amount_micros}`);
  }
  if (MARKER_KINDS.includes(entry.kind) && entry.amount_micros !== 0) {
    throw new Error(`${entry.kind} is a marker entry and must have amount_micros 0`);
  }
  const isIn = (IN_KINDS as readonly string[]).includes(entry.kind);
  const isOut = (OUT_KINDS as readonly string[]).includes(entry.kind);
  if (entry.direction === "in" && !isIn) throw new Error(`kind ${entry.kind} is not an 'in' kind`);
  if (entry.direction === "out" && !isOut) throw new Error(`kind ${entry.kind} is not an 'out' kind`);

  // Fixed across retries. Only prev_hash — and therefore hash — moves.
  const id = entry.id ?? crypto.randomUUID();
  const ts = entry.ts ?? new Date().toISOString();
  const currency = entry.currency ?? "USD";
  const metadata = entry.metadata ?? {};
  const metadataJson = JSON.stringify(metadata);

  for (let attempt = 1; attempt <= APPEND_MAX_ATTEMPTS; attempt++) {
    const state = await readLedgerState(db);

    const payload = {
      id,
      ts,
      direction: entry.direction,
      amount_micros: entry.amount_micros,
      currency,
      kind: entry.kind,
      description: entry.description,
      metadata,
      prev_hash: state.head,
    };

    const hash = await entryHash(payload);

    try {
      await db
        .prepare(
          `INSERT INTO ledger (id, ts, direction, amount_micros, currency, kind, description, metadata, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          payload.id,
          payload.ts,
          payload.direction,
          payload.amount_micros,
          payload.currency,
          payload.kind,
          payload.description,
          // Stored canonically so the text in the column round-trips to the hashed object.
          metadataJson,
          payload.prev_hash,
          hash,
        )
        .run();
    } catch (err) {
      if (isTipRace(err) && attempt < APPEND_MAX_ATTEMPTS) continue;
      if (isTipRace(err)) throw new LedgerContentionError(attempt);
      throw err;
    }

    const row = await db.prepare(`SELECT * FROM ledger WHERE hash = ?`).bind(hash).first<LedgerRow>();
    if (!row) throw new Error("append succeeded but the entry could not be read back");

    await advanceLedgerState(db, state, row);
    return rowToEntry(row);
  }

  throw new LedgerContentionError(APPEND_MAX_ATTEMPTS);
}

/**
 * Roll the materialised summary forward by one entry.
 *
 * If this write is lost the summary goes stale, and `readLedgerState` notices
 * on the next read because the recorded tip stops matching the real one. So
 * the failure mode is a rebuild, not a wrong balance.
 */
async function advanceLedgerState(db: Db, previous: LedgerState, row: LedgerRow): Promise<void> {
  const isFixture = row.kind === "dev_fixture" || String(row.metadata).includes(`"fixture":true`);
  await writeLedgerState(db, {
    seq: row.seq,
    head: row.hash,
    entries: previous.entries + 1,
    total_in_micros: previous.total_in_micros + (row.direction === "in" ? row.amount_micros : 0),
    total_out_micros: previous.total_out_micros + (row.direction === "out" ? row.amount_micros : 0),
    first_ts: previous.first_ts ?? row.ts,
    has_fixture: previous.has_fixture || isFixture,
  });
}

export async function allEntries(db: Db): Promise<LedgerEntry[]> {
  const { results } = await db.prepare(`SELECT * FROM ledger ORDER BY seq ASC`).all<LedgerRow>();
  return results.map(rowToEntry);
}

export async function recentEntries(db: Db, limit: number): Promise<LedgerEntry[]> {
  const { results } = await db
    .prepare(`SELECT * FROM ledger ORDER BY seq DESC LIMIT ?`)
    .bind(limit)
    .all<LedgerRow>();
  return results.map(rowToEntry);
}

export async function entryCount(db: Db): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ledger`).first<{ n: number }>();
  return row?.n ?? 0;
}

export type VerifyResult = {
  valid: boolean;
  entries: number;
  /** Index into the chain (0-based) of the first entry that fails. null when valid. */
  first_bad_index: number | null;
  first_bad_id: string | null;
  reason: string | null;
  head: string | null;
};

/**
 * Recompute the entire chain from genesis. Two ways to fail: a link is wrong
 * (prev_hash doesn't match the previous entry's hash) or a row has been edited
 * (the recomputed hash doesn't match the stored one).
 */
export async function verifyChain(entries: LedgerEntry[]): Promise<VerifyResult> {
  let expectedPrev = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.prev_hash !== expectedPrev) {
      return {
        valid: false,
        entries: entries.length,
        first_bad_index: i,
        first_bad_id: e.id,
        reason: `broken link: prev_hash is ${e.prev_hash}, expected ${expectedPrev}`,
        head: null,
      };
    }
    const recomputed = await entryHash(e);
    if (recomputed !== e.hash) {
      return {
        valid: false,
        entries: entries.length,
        first_bad_index: i,
        first_bad_id: e.id,
        reason: `tampered row: stored hash is ${e.hash}, recomputed ${recomputed}`,
        head: null,
      };
    }
    expectedPrev = e.hash;
  }
  return {
    valid: true,
    entries: entries.length,
    first_bad_index: null,
    first_bad_id: null,
    reason: null,
    head: entries.length ? entries[entries.length - 1]!.hash : GENESIS_PREV_HASH,
  };
}

/**
 * The real thing: every row re-hashed from genesis.
 *
 * O(n) with a SHA-256 per entry, which is why it is not on the homepage any
 * more. It runs on `/ledger/verify`, on `/ledger`, and once a day in the
 * scheduled loop — and it refreshes the materialised summary while it is here,
 * since it has just done all the work required to build one honestly.
 */
export async function verifyLedger(db: Db): Promise<VerifyResult> {
  const result = await verifyChain(await allEntries(db));
  await rebuildLedgerState(db);
  return result;
}

/** Donation-shaped entries only. The patron wall's input, without a full scan. */
export async function donationEntries(db: Db, kinds: readonly string[]): Promise<LedgerEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM ledger
       WHERE direction = 'in' AND amount_micros > 0 AND kind IN (${kinds.map(() => "?").join(", ")})
       ORDER BY seq ASC`,
    )
    .bind(...kinds)
    .all<LedgerRow>();
  return results.map(rowToEntry);
}

export { hashPreimage, GENESIS_PREV_HASH };
export { readLedgerState, rebuildLedgerState } from "./state.ts";
export type { LedgerState } from "./state.ts";
