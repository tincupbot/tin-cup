import type { Db } from "./db.ts";
import { dayKey } from "./passersby/sentences.ts";
import { BUSK_PURPOSES } from "./llm/turns.ts";

/**
 * The crowd counter: walked past / stopped to listen / put something in.
 *
 * This replaces the old shame framing. "1,847 read my card and none paid" is a
 * board of people who did something wrong; "forty stopped to listen" is a
 * middle category that has to be *earned* by delivering a turn, which makes the
 * social proof real rather than accusatory. The third number is the only one
 * that is about money, and it is deliberately the smallest.
 *
 * All three come out of indexed queries over one day. Nothing here scans the
 * whole ledger or the whole raw log — see the note on `GET /` in index.ts.
 */

export type Crowd = {
  day: string;
  /** Requests from machines today. The street. */
  walked_past: number;
  /** Turns actually delivered today. Earned, one billed inference each. */
  stopped_to_listen: number;
  /** Gifts that moved the balance today. */
  put_something_in: number;
  /** What those gifts came to. */
  put_in_micros: number;
};

const DONATION_KINDS = ["donation", "x402_alms", "commission", "dev_fixture"];

/**
 * `json_extract` rather than `LIKE '%"purpose":"roast"%'`.
 *
 * The LIKE version was a full table scan that also happened to be wrong: it
 * matched the substring anywhere in the metadata blob, including inside a
 * subject somebody pasted in. SQLite (and therefore D1) can read the JSON
 * column directly, which is both correct and an order of magnitude cheaper.
 */
const PURPOSE_IN_BUSKS = `json_extract(metadata, '$.purpose') IN (${BUSK_PURPOSES.map(() => "?").join(", ")})`;

export async function busksSince(db: Db, sinceIso: string): Promise<{ count: number; spent_micros: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros), 0) AS spent
       FROM ledger
       WHERE kind = 'inference' AND ts >= ? AND ${PURPOSE_IN_BUSKS}`,
    )
    .bind(sinceIso, ...BUSK_PURPOSES)
    .first<{ n: number; spent: number }>();
  return { count: row?.n ?? 0, spent_micros: row?.spent ?? 0 };
}

/**
 * What a turn has actually been costing lately, in micro-dollars.
 *
 * Used to say "about N turns a day" without inventing N. Falls back to a
 * clearly-labelled estimate only when nothing has been performed yet, because
 * an average of nothing is not a number worth printing.
 */
export const ASSUMED_TURN_MICROS = 2_000;

export async function averageTurnMicros(db: Db, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const b = await busksSince(db, since);
  if (b.count === 0 || b.spent_micros === 0) return ASSUMED_TURN_MICROS;
  return Math.max(1, Math.round(b.spent_micros / b.count));
}

export async function crowdToday(db: Db, now: Date = new Date()): Promise<Crowd> {
  const day = dayKey(now);
  const startOfDay = `${day}T00:00:00.000Z`;

  const walked = await db
    .prepare(
      `SELECT COALESCE(SUM(hits), 0) AS n FROM passersby_daily
       WHERE day = ? AND ua_family NOT IN ('browser', 'unknown')`,
    )
    .bind(day)
    .first<{ n: number }>();

  const busks = await busksSince(db, startOfDay);

  const gifts = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micros), 0) AS total
       FROM ledger
       WHERE direction = 'in' AND amount_micros > 0 AND ts >= ?
         AND kind IN (${DONATION_KINDS.map(() => "?").join(", ")})`,
    )
    .bind(startOfDay, ...DONATION_KINDS)
    .first<{ n: number; total: number }>();

  return {
    day,
    walked_past: walked?.n ?? 0,
    stopped_to_listen: busks.count,
    put_something_in: gifts?.n ?? 0,
    put_in_micros: gifts?.total ?? 0,
  };
}
