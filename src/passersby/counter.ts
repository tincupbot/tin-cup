import type { Db } from "../db.ts";
import { classifyUa, isMachine, shouldLog, surfaceFor, type Surface } from "./classify.ts";
import { dayKey, dailyLine, namedCrawlerLine, type CrawlerStats, type DayStats } from "./sentences.ts";

/**
 * Two stores, deliberately:
 *
 *  - `passersby` is the raw log. Rich, and it gets big.
 *  - `passersby_daily` is the aggregate the site actually reads. Bounded by
 *    (days × families × surfaces), so the front page is a handful of rows
 *    however much traffic arrives.
 *
 * The raw log exists because "GPTBot, 412 times, never paid" has to be
 * defensible if someone asks to see it.
 */

export type LogInput = {
  path: string;
  ua: string | null | undefined;
  paid?: boolean;
  /**
   * True only when the edge corroborated the client's identity — Cloudflare's
   * verified-bot signal. Never derive this from the user-agent string; that is
   * the thing being checked, not evidence about it.
   */
  verified?: boolean;
  now?: Date;
};

export async function logPasserBy(db: Db, input: LogInput): Promise<boolean> {
  const family = classifyUa(input.ua);
  if (!shouldLog(input.path, family)) return false;

  const now = input.now ?? new Date();
  const ts = now.toISOString();
  const day = dayKey(now);
  const surface = surfaceFor(input.path);
  const paid = input.paid ? 1 : 0;
  const verified = input.verified ? 1 : 0;
  // Long UA strings are mostly boilerplate; 512 is generous and bounds the row.
  const ua = (input.ua ?? "").slice(0, 512);

  await db
    .prepare(
      `INSERT INTO passersby (ts, day, path, surface, ua, ua_family, paid, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(ts, day, input.path, surface, ua, family, paid, verified)
    .run();

  await db
    .prepare(
      `INSERT INTO passersby_daily (day, ua_family, surface, hits, paid, verified_hits)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, ua_family, surface)
       DO UPDATE SET hits = hits + 1,
                     paid = paid + excluded.paid,
                     verified_hits = verified_hits + excluded.verified_hits`,
    )
    .bind(day, family, surface, paid, verified)
    .run();

  return true;
}

const CARD_SURFACES = ["agent_card", "llms_txt", "alms"] as const;

function isCardSurface(s: string): s is Surface {
  return (CARD_SURFACES as readonly string[]).includes(s);
}

export async function statsForDay(db: Db, day: string): Promise<DayStats> {
  const { results } = await db
    .prepare(`SELECT ua_family, surface, hits, paid FROM passersby_daily WHERE day = ?`)
    .bind(day)
    .all<{ ua_family: string; surface: string; hits: number; paid: number }>();

  let machineRequests = 0;
  let cardReads = 0;
  let paid = 0;
  for (const r of results) {
    if (isMachine(r.ua_family)) machineRequests += r.hits;
    if (isCardSurface(r.surface)) {
      cardReads += r.hits;
      paid += r.paid;
    }
  }

  const uniq = await db
    .prepare(`SELECT COUNT(DISTINCT ua) AS n FROM passersby WHERE day = ?`)
    .bind(day)
    .first<{ n: number }>();

  return {
    day,
    machine_requests: machineRequests,
    unique_agents: uniq?.n ?? 0,
    card_reads: cardReads,
    paid,
  };
}

export async function todayLine(db: Db, now: Date = new Date()): Promise<string> {
  return dailyLine(await statsForDay(db, dayKey(now)), true);
}

export type FamilyTotals = {
  family: string;
  reads: number;
  paid: number;
  requests: number;
  /** Reads the edge corroborated. Zero means every one of them was self-declared. */
  verifiedReads: number;
};

/** Top crawlers by name over the last `days` days. Machines only — browsers are not the joke. */
export async function topCrawlers(db: Db, days: number, now: Date = new Date(), limit = 10): Promise<FamilyTotals[]> {
  const since = dayKey(new Date(now.getTime() - days * 86_400_000));
  const { results } = await db
    .prepare(
      `SELECT ua_family,
              SUM(hits) AS requests,
              SUM(CASE WHEN surface IN ('agent_card','llms_txt','alms') THEN hits ELSE 0 END) AS reads,
              SUM(CASE WHEN surface IN ('agent_card','llms_txt','alms') THEN verified_hits ELSE 0 END) AS verified_reads,
              SUM(paid) AS paid
       FROM passersby_daily
       WHERE day >= ?
       GROUP BY ua_family
       ORDER BY requests DESC`,
    )
    .bind(since)
    .all<{ ua_family: string; requests: number; reads: number; verified_reads: number; paid: number }>();

  return results
    .filter((r) => isMachine(r.ua_family))
    .slice(0, limit)
    .map((r) => ({
      family: r.ua_family,
      reads: r.reads,
      paid: r.paid,
      requests: r.requests,
      verifiedReads: r.verified_reads ?? 0,
    }));
}

/**
 * The named line, for the loudest crawler that has read the card and not paid.
 * Returns null when nobody qualifies — better silence than a sentence about zero.
 *
 * A corroborated crawler is always preferred over a louder uncorroborated one,
 * even when the uncorroborated one has a bigger number. The big number is the
 * one an attacker would manufacture, so it is exactly the one not to lead with.
 */
export async function namedLine(db: Db, days = 7, now: Date = new Date()): Promise<string | null> {
  const crawlers = await topCrawlers(db, days, now);

  const unpaid = crawlers.filter((c) => c.reads > 0 && c.paid === 0);
  const anyReader = crawlers.filter((c) => c.reads > 0);

  const target =
    unpaid.find((c) => c.verifiedReads > 0) ??
    anyReader.find((c) => c.verifiedReads > 0) ??
    unpaid[0] ??
    anyReader[0];

  if (!target) return null;

  const verified = target.verifiedReads > 0;
  const period = days <= 1 ? "today" : days <= 7 ? "this week" : `in the last ${days} days`;

  return namedCrawlerLine({
    family: target.family,
    // When the name is corroborated, count only the corroborated reads. Mixing
    // proven and claimed requests into one total would publish a number that is
    // part evidence and part someone else's input.
    reads: verified ? target.verifiedReads : target.reads,
    paid: target.paid,
    period,
    verified,
  });
}

export type CounterSummary = {
  today: DayStats;
  today_line: string;
  named_line: string | null;
  totals: { machine_requests: number; unique_agents: number; card_reads: number; paid: number };
  /** Read the card or the wallet endpoint and did not pay. The number that matters. */
  read_and_walked_on: number;
  top_crawlers: FamilyTotals[];
  by_surface: Array<{ surface: string; hits: number; paid: number }>;
};

export async function summary(db: Db, now: Date = new Date()): Promise<CounterSummary> {
  const today = await statsForDay(db, dayKey(now));

  const { results: familyRows } = await db
    .prepare(
      `SELECT ua_family,
              SUM(hits) AS hits,
              SUM(CASE WHEN surface IN ('agent_card','llms_txt','alms') THEN hits ELSE 0 END) AS reads,
              SUM(paid) AS paid
       FROM passersby_daily GROUP BY ua_family`,
    )
    .all<{ ua_family: string; hits: number; reads: number; paid: number }>();

  let machineRequests = 0;
  let cardReads = 0;
  let paid = 0;
  for (const r of familyRows) {
    if (isMachine(r.ua_family)) machineRequests += r.hits;
    cardReads += r.reads;
    paid += r.paid;
  }

  const uniq = await db.prepare(`SELECT COUNT(DISTINCT ua) AS n FROM passersby`).first<{ n: number }>();

  const { results: bySurface } = await db
    .prepare(`SELECT surface, SUM(hits) AS hits, SUM(paid) AS paid FROM passersby_daily GROUP BY surface ORDER BY hits DESC`)
    .all<{ surface: string; hits: number; paid: number }>();

  return {
    today,
    today_line: dailyLine(today, true),
    named_line: await namedLine(db, 7, now),
    totals: {
      machine_requests: machineRequests,
      unique_agents: uniq?.n ?? 0,
      card_reads: cardReads,
      paid,
    },
    read_and_walked_on: Math.max(0, cardReads - paid),
    top_crawlers: await topCrawlers(db, 30, now),
    by_surface: bySurface.map((r) => ({ surface: r.surface, hits: r.hits, paid: r.paid })),
  };
}

export { dayKey, dailyLine, namedCrawlerLine };
export type { DayStats, CrawlerStats };
