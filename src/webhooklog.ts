import type { Db } from "./db.ts";
import type { KofiPayload, KofiResult } from "./kofi.ts";
import { usdToMicros } from "./money.ts";

/**
 * The delivery log: one row per money-shaped request that arrived, whatever we
 * then decided to do with it.
 *
 * See `migrations/0002_webhook_deliveries.sql` for why this exists. The short
 * version: the outcomes that do *not* become ledger entries were invisible
 * after the fact, so a webhook that never fired and a webhook that was refused
 * looked the same, and proving the Ko-fi path meant standing next to it with
 * `wrangler tail` running.
 *
 * This is an operational record, not the books. It never decides money and
 * nothing reads it to compute a balance — if this table and the ledger ever
 * disagree, the ledger is right by construction.
 */

export type DeliveryOutcome = "booked" | "duplicate" | "test_payment" | "dry_run" | "rejected";

export type DeliveryRow = {
  id: number;
  ts: string;
  source: string;
  outcome: DeliveryOutcome;
  reason: string | null;
  http_status: number;
  amount_micros: number | null;
  currency: string | null;
  event_type: string | null;
  ledger_id: string | null;
};

/**
 * What the payload *claimed*, for the rows where we never got as far as
 * believing it. Deliberately forgiving: a rejected delivery is exactly the case
 * where the fields may be missing or malformed, and a NULL here is a truer
 * record than a zero.
 */
function claimedAmountMicros(payload: KofiPayload | null): number | null {
  if (!payload) return null;
  const n = Number(payload.amount);
  if (!Number.isFinite(n) || n < 0) return null;
  return usdToMicros(n);
}

/**
 * Never called with a token, a supporter email, a supporter name or a
 * supporter message — see the migration header. The argument is the payload so
 * the caller cannot forget which fields are safe; the picking happens here, in
 * one place, rather than at each call site.
 */
export async function recordDelivery(
  db: Db,
  args: {
    source: string;
    outcome: DeliveryOutcome;
    reason?: string | null;
    httpStatus: number;
    payload: KofiPayload | null;
    ledgerId?: string | null;
    ts?: Date;
  },
): Promise<void> {
  const ts = (args.ts ?? new Date()).toISOString();
  const currency = args.payload?.currency ? String(args.payload.currency).toUpperCase().slice(0, 8) : null;
  const eventType = args.payload?.type ? String(args.payload.type).slice(0, 48) : null;

  await db
    .prepare(
      `INSERT INTO webhook_deliveries
         (ts, source, outcome, reason, http_status, amount_micros, currency, event_type, ledger_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ts,
      args.source,
      args.outcome,
      args.reason ?? null,
      args.httpStatus,
      claimedAmountMicros(args.payload),
      currency,
      eventType,
      args.ledgerId ?? null,
    )
    .run();
}

/** Maps a handler result onto the row it should leave behind. */
export function outcomeOf(result: KofiResult): { outcome: DeliveryOutcome; reason: string | null; ledgerId: string | null } {
  switch (result.status) {
    case "rejected":
      return { outcome: "rejected", reason: result.reason, ledgerId: null };
    case "observed":
      return {
        outcome: result.reason === "ko-fi test payment" ? "test_payment" : "dry_run",
        reason: result.reason,
        ledgerId: null,
      };
    case "ok":
      return result.duplicate
        ? { outcome: "duplicate", reason: "already booked", ledgerId: result.ledgerId }
        : { outcome: "booked", reason: null, ledgerId: result.entry.id };
  }
}

export async function recentDeliveries(db: Db, limit = 50): Promise<DeliveryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, ts, source, outcome, reason, http_status, amount_micros, currency, event_type, ledger_id
         FROM webhook_deliveries ORDER BY id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<DeliveryRow>();
  return results;
}

/** Cheap enough to put on /health: the operator's "has it ever fired?" answer. */
export async function lastDeliveryAt(db: Db, source: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT ts FROM webhook_deliveries WHERE source = ? ORDER BY id DESC LIMIT 1`)
    .bind(source)
    .first<{ ts: string }>();
  return row?.ts ?? null;
}
