import type { Db } from "../db.ts";
import { GENESIS_PREV_HASH, entryHash, hashPreimage } from "./hash.ts";

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

/**
 * Append one entry. This is the only write path to the ledger in the codebase.
 *
 * Not safe against concurrent writers by construction — two simultaneous appends
 * could read the same tip. The UNIQUE index on `hash` makes the loser fail loudly
 * rather than silently forking the chain, which is the behaviour we want. At this
 * project's traffic, the race is theoretical; see README "Known limits".
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

  const tip = await db
    .prepare(`SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1`)
    .first<{ hash: string }>();

  const payload = {
    id: entry.id ?? crypto.randomUUID(),
    ts: entry.ts ?? new Date().toISOString(),
    direction: entry.direction,
    amount_micros: entry.amount_micros,
    currency: entry.currency ?? "USD",
    kind: entry.kind,
    description: entry.description,
    metadata: entry.metadata ?? {},
    prev_hash: tip?.hash ?? GENESIS_PREV_HASH,
  };

  const hash = await entryHash(payload);

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
      JSON.stringify(payload.metadata),
      payload.prev_hash,
      hash,
    )
    .run();

  const row = await db.prepare(`SELECT * FROM ledger WHERE hash = ?`).bind(hash).first<LedgerRow>();
  if (!row) throw new Error("append succeeded but the entry could not be read back");
  return rowToEntry(row);
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

export async function verifyLedger(db: Db): Promise<VerifyResult> {
  return verifyChain(await allEntries(db));
}

export { hashPreimage, GENESIS_PREV_HASH };
