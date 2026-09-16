import type { Db } from "../db.ts";
import { classifyUa, isMachine, shouldLog, surfaceFor, type Surface } from "./classify.ts";
import { dayKey, dailyLine, namedCrawlerLine, type CrawlerStats, type DayStats } from "./sentences.ts";

/**
 * Three stores, and which one a request touches is a cost decision:
 *
 *  - `passersby_daily` is the aggregate the site reads. One upsert per logged
 *    request, bounded by (days × families × surfaces), so the front page reads
 *    a handful of rows however much traffic arrives. Counts are exact.
 *  - `passersby_agents` is one row per distinct agent per day, claimed with
 *    INSERT OR IGNORE. It exists so "how many distinct machines" stops being
 *    `COUNT(DISTINCT ua)` over an unbounded, unindexed log.
 *  - `passersby` is the raw log, now **sampled and pruned**. It is evidence,
 *    not a counter: "GPTBot, 412 times, never paid" comes from the aggregate,
 *    and the raw rows are there so a sample of them can be shown to anyone who
 *    asks what that claim is made of.
 *
 * Before this, every request — including every 404 — did two unconditional
 * writes. A browser reading the front page now does none at all.
 */

/** Non-card surfaces are logged raw one time in this many. Cards are always logged. */
export const DEFAULT_RAW_SAMPLE_ONE_IN = 10;

/** How many days of raw log to keep. The aggregate is kept forever; it is tiny. */
export const RAW_LOG_KEEP_DAYS = 7;

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
  /** Override the raw-log sample rate. 1 logs everything; tests use it. */
  rawSampleOneIn?: number;
  /** Test seam for the sampler. Defaults to Math.random. */
  random?: () => number;
};

export type LogOutcome = { logged: boolean; aggregated: boolean; raw: boolean };

const NOT_LOGGED: LogOutcome = { logged: false, aggregated: false, raw: false };

export async function logPasserBy(db: Db, input: LogInput): Promise<LogOutcome> {
  const family = classifyUa(input.ua);
  if (!shouldLog(input.path, family)) return NOT_LOGGED;

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
      `INSERT INTO passersby_daily (day, ua_family, surface, hits, paid, verified_hits)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, ua_family, surface)
       DO UPDATE SET hits = hits + 1,
                     paid = paid + excluded.paid,
                     verified_hits = verified_hits + excluded.verified_hits`,
    )
    .bind(day, family, surface, paid, verified)
    .run();

  // A card read is rare and is the thing the whole counter is about, so it is
  // never sampled away. Everything else is.
  const isCard = surface !== "other";
  const oneIn = Math.max(1, input.rawSampleOneIn ?? DEFAULT_RAW_SAMPLE_ONE_IN);
  const rnd = input.random ?? Math.random;
  const keepRaw = isCard || oneIn === 1 || rnd() < 1 / oneIn;

  if (keepRaw) {
    await db
      .prepare(
        `INSERT INTO passersby (ts, day, path, surface, ua, ua_family, paid, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ts, day, input.path, surface, ua, family, paid, verified)
      .run();

    await db
      .prepare(
        `INSERT INTO passersby_agents (day, ua, ua_family, first_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, ua) DO NOTHING`,
      )
      .bind(day, ua, family, ts)
      .run();
  }

  return { logged: true, aggregated: true, raw: keepRaw };
}

/**
 * Drop raw rows older than the retention window. Called from the scheduled run,
 * never from a request. The aggregate and the agent list are untouched — they
 * are what the site reads, and they are small enough to keep indefinitely.
 */
export async function prunePassersby(db: Db, now: Date = new Date(), keepDays = RAW_LOG_KEEP_DAYS): Promise<void> {
  const cutoff = dayKey(new Date(now.getTime() - keepDays * 86_400_000));
  await db.prepare(`DELETE FROM passersby WHERE day < ?`).bind(cutoff).run();
  await db.prepare(`DELETE FROM passersby_agents WHERE day < ?`).bind(cutoff).run();
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

  // One indexed row per distinct agent, rather than a DISTINCT over every
  // request ever logged. See the note on `passersby_agents`.
  const uniq = await db
    .prepare(`SELECT COUNT(*) AS n FROM passersby_agents WHERE day = ?`)
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
  /**
   * `unique_agents` is exact for anything that read a machine surface — those
   * are never sampled — and a lower bound everywhere else, because the raw log
   * behind it is sampled. Every other number here is exact: they come from the
   * aggregate, which is written on every request.
   */
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

  const uniq = await db.prepare(`SELECT COUNT(DISTINCT ua) AS n FROM passersby_agents`).first<{ n: number }>();

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
