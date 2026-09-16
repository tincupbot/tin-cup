/**
 * Seed the LOCAL miniflare D1 database with a fake ten-day history.
 *
 * Run:  npm run seed:dev        (wrangler dev must NOT be running)
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER THIS SCRIPT WRITES IS INVENTED.
 *
 * Nobody donated. No model was called. No agent paid for anything. The point of
 * the fixture is to make the site demonstrable before it has a real past, which
 * is exactly the situation where fake money is most likely to be mistaken for
 * real money. So: every ledger row carries `metadata.fixture = true`, every
 * description starts with "DEV FIXTURE", and `hasFixtureData()` lights the
 * banner across the whole site for as long as a single one of these rows exists.
 * ---------------------------------------------------------------------------
 *
 * The hash chain is real even though the money isn't — entries go through the
 * same append path as live ones, so /ledger/verify genuinely verifies.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { Db, DbStatement } from "../src/db.ts";
import { resetDatabase } from "./migrations.ts";
import { append } from "../src/ledger/ledger.ts";
import { classifyUa, surfaceFor, shouldLog } from "../src/passersby/classify.ts";
import { dayKey } from "../src/passersby/sentences.ts";
import { costMicros, ROUTINE_MODEL } from "../src/llm/pricing.ts";
import { MICROS_PER_USD } from "../src/money.ts";

// `new URL(...)` resolves to the Workers URL type under this tsconfig, which is
// structurally incompatible with node:url's. The string overload sidesteps it.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url).href), "..");
const D1_DIR = join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function findLocalD1(): string {
  let files: string[];
  try {
    files = readdirSync(D1_DIR);
  } catch {
    throw new Error(
      `No local D1 state at ${D1_DIR}.\nStart the dev server once (npm run dev) so miniflare creates it, stop it, then re-run this.`,
    );
  }
  const candidates = files.filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one D1 database file in ${D1_DIR}, found: ${candidates.join(", ") || "none"}`);
  }
  return join(D1_DIR, candidates[0]!);
}

/** node:sqlite wearing the `Db` interface, so seeding uses the real append path. */
function nodeDb(sqlite: DatabaseSync): Db {
  return {
    prepare(sql: string): DbStatement {
      let bound: unknown[] = [];
      const stmt: DbStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return stmt;
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...(bound as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all(...(bound as never[])) as T[] };
        },
        async run() {
          return sqlite.prepare(sql).run(...(bound as never[]));
        },
      };
      return stmt;
    },
  };
}

const DAY_MS = 86_400_000;
const usd = (n: number) => Math.round(n * MICROS_PER_USD);

/** Deterministic PRNG, so two runs of the fixture produce the same story. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// --- The story -------------------------------------------------------------
// Ten days: seeded with $5, burns it, dies on day 7, someone brings it back.

/** Roasts served per day, oldest first. Day 0 is nine days ago. */
const ROASTS_PER_DAY = [180, 240, 310, 205, 260, 290, 175, 330, 420, 380, 150];

type Gift = { dayIndex: number; hour: number; kind: "startup_capital" | "donation" | "x402_alms"; usd: number; description: string; metadata?: Record<string, unknown> };

const GIFTS: Gift[] = [
  { dayIndex: 0, hour: 9, kind: "startup_capital", usd: 5, description: "Seed float from the operator.", metadata: { source: "operator" } },
  { dayIndex: 2, hour: 14, kind: "x402_alms", usd: 0.01, description: "An agent paid the 402 and took a blessing.", metadata: { network: "base-sepolia", payer: "0xPLACEHOLDER" } },
  { dayIndex: 5, hour: 11, kind: "x402_alms", usd: 0.01, description: "An agent paid the 402 and took a blessing.", metadata: { network: "base-sepolia", payer: "0xPLACEHOLDER" } },
  // Arrives the morning after it runs out — which is what makes the gap in the
  // ledger, and the resurrection marker, exist at all.
  { dayIndex: 7, hour: 9, kind: "donation", usd: 5, description: "Ko-fi: \"get up\"", metadata: { platform: "ko-fi", from: "a stranger" } },
  { dayIndex: 8, hour: 8, kind: "donation", usd: 3, description: "Ko-fi: \"for the cup\"", metadata: { platform: "ko-fi", from: "a stranger" } },
  { dayIndex: 9, hour: 16, kind: "x402_alms", usd: 0.02, description: "Two agents paid the 402 within a minute of each other.", metadata: { network: "base-sepolia", count: 2 } },
  { dayIndex: 10, hour: 10, kind: "donation", usd: 1, description: "Ko-fi: \"this is very stupid\"", metadata: { platform: "ko-fi", from: "a stranger" } },
];

const UA_POOL: Array<{ ua: string; weight: number }> = [
  { ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot", weight: 22 },
  { ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com", weight: 14 },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude-User/1.0", weight: 6 },
  { ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot", weight: 9 },
  { ua: "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)", weight: 11 },
  { ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", weight: 8 },
  { ua: "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)", weight: 5 },
  { ua: "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", weight: 5 },
  { ua: "CCBot/2.0 (https://commoncrawl.org/faq/)", weight: 4 },
  { ua: "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", weight: 4 },
  { ua: "python-requests/2.32.3", weight: 5 },
  { ua: "curl/8.7.1", weight: 3 },
  { ua: "node-fetch/3.3.2", weight: 3 },
  { ua: "x402-fetch/0.4.1", weight: 2 },
  { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", weight: 7 },
  { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", weight: 6 },
];

const PATH_POOL: Array<{ path: string; weight: number }> = [
  // Card reads are the interesting number, so resist the urge to inflate them.
  // Most of what hits a site like this is an indexer taking the front page.
  { path: "/", weight: 70 },
  { path: "/ledger", weight: 14 },
  { path: "/llms.txt", weight: 8 },
  { path: "/.well-known/agent.json", weight: 7 },
  { path: "/passers-by", weight: 8 },
  { path: "/robots.txt", weight: 6 },
  { path: "/alms", weight: 5 },
];

function weightedPick<T extends { weight: number }>(pool: T[], r: number): T {
  const total = pool.reduce((a, b) => a + b.weight, 0);
  let x = r * total;
  for (const item of pool) {
    x -= item.weight;
    if (x <= 0) return item;
  }
  return pool[pool.length - 1]!;
}

/** Requests per day, oldest first. Nobody knows it exists yet, so: not many. */
const HITS_PER_DAY = [140, 190, 260, 210, 300, 340, 280, 420, 560, 610, 380];

async function main() {
  const path = findLocalD1();
  const sqlite = new DatabaseSync(path);
  const db = nodeDb(sqlite);

  // Wipe. DROP is not blocked by the append-only triggers (they guard rows, not
  // the table), and this is disposable local dev state by definition. See
  // `npm run db:reset` and the README for the standalone version of this.
  console.log(`Resetting local D1 at ${path}`);
  resetDatabase(sqlite);

  const now = new Date();
  const days = ROASTS_PER_DAY.length;
  const day0 = new Date(now.getTime() - (days - 1) * DAY_MS);
  const at = (dayIndex: number, hour: number, minute = 0) => {
    const d = new Date(day0.getTime() + dayIndex * DAY_MS);
    d.setUTCHours(hour, minute, 0, 0);
    return d;
  };

  // Build every event, then sort by time — the chain must be appended in order.
  type Event = { ts: Date; run: () => Promise<void> };
  const events: Event[] = [];

  for (const g of GIFTS) {
    const ts = at(g.dayIndex, g.hour, 22);
    events.push({
      ts,
      run: async () => {
        await append(db, {
          direction: "in",
          amount_micros: usd(g.usd),
          kind: g.kind,
          description: `DEV FIXTURE — ${g.description}`,
          metadata: { ...(g.metadata ?? {}), fixture: true },
          ts: ts.toISOString(),
        });
      },
    });
  }

  const rand = rng(20260915);
  for (let d = 0; d < days; d++) {
    const roasts = ROASTS_PER_DAY[d]!;
    // One rolled-up entry per day. Itemising 400 roasts would be honest and
    // completely unreadable; the roast count and token totals are in metadata.
    let inTok = 0;
    let outTok = 0;
    for (let i = 0; i < roasts; i++) {
      inTok += 820 + Math.floor(rand() * 420);
      outTok += 300 + Math.floor(rand() * 200);
    }
    // Plus the day's post, which it writes whether or not anyone is reading.
    inTok += 1400;
    outTok += 240;
    const cost = costMicros(ROUTINE_MODEL, inTok, outTok);
    const ts = at(d, 23, 50);
    events.push({
      ts,
      run: async () => {
        await append(db, {
          direction: "out",
          amount_micros: cost,
          kind: "inference",
          description: `DEV FIXTURE — ${roasts} roasts and one daily post (${ROUTINE_MODEL})`,
          metadata: {
            fixture: true,
            model: ROUTINE_MODEL,
            roasts,
            input_tokens: inTok,
            output_tokens: outTok,
          },
          ts: ts.toISOString(),
        });
      },
    });
  }

  events.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Replay, reconciling life and death after each one exactly as the live code
  // does — so the death and resurrection markers land where the money says.
  let balance = 0;
  let alive = true;
  let resurrections = 0;
  let diedAt: string | null = null;

  const readBalance = () => {
    const row = sqlite
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_micros ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN direction='out' THEN amount_micros ELSE 0 END),0) AS bal FROM ledger`,
      )
      .get() as { bal: number };
    return row.bal;
  };

  for (const e of events) {
    await e.run();
    balance = readBalance();
    const ts = e.ts.toISOString();

    if (balance <= 0 && alive) {
      await append(db, {
        direction: "in",
        amount_micros: 0,
        kind: "death",
        description: "Out of money. Inference stopped.",
        metadata: { fixture: true, event: "death", final_balance_micros: balance, lifetime_number: resurrections + 1 },
        ts,
      });
      alive = false;
      diedAt = ts;
    } else if (balance > 0 && !alive) {
      resurrections += 1;
      await append(db, {
        direction: "in",
        amount_micros: 0,
        kind: "resurrection",
        description: resurrections === 1 ? "Someone put money in the cup. Back." : `Back again. Resurrection number ${resurrections}.`,
        metadata: {
          fixture: true,
          event: "resurrection",
          resurrection_number: resurrections,
          died_at: diedAt,
          balance_micros_on_return: balance,
          dead_for_seconds: diedAt ? Math.round((e.ts.getTime() - Date.parse(diedAt)) / 1000) : null,
        },
        ts,
      });
      alive = true;
      diedAt = null;
    }
  }

  const setState = sqlite.prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  setState.run("alive", alive ? "true" : "false");
  setState.run("resurrections", String(resurrections));
  setState.run("died_at", diedAt ?? "");

  // --- Passers-by ----------------------------------------------------------
  // Raw rows first, aggregate derived from them, so "GPTBot, 412 times" can be
  // checked against the log rather than taken on trust.
  const r2 = rng(777);
  const rawInsert = sqlite.prepare(
    `INSERT INTO passersby (ts, day, path, surface, ua, ua_family, paid) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const paidStamps = new Set(
    GIFTS.filter((g) => g.kind === "x402_alms").map((g) => `${g.dayIndex}:${g.hour}`),
  );

  sqlite.exec("BEGIN");
  let logged = 0;
  for (let d = 0; d < days; d++) {
    const hits = HITS_PER_DAY[d]!;
    for (let i = 0; i < hits; i++) {
      const ua = weightedPick(UA_POOL, r2()).ua;
      const p = weightedPick(PATH_POOL, r2()).path;
      const family = classifyUa(ua);
      if (!shouldLog(p, family)) continue;
      const hour = Math.floor(r2() * 24);
      const ts = at(d, hour, Math.floor(r2() * 60));
      const paid = p === "/alms" && paidStamps.has(`${d}:${hour}`) ? 1 : 0;
      rawInsert.run(ts.toISOString(), dayKey(ts), p, surfaceFor(p), ua, family, paid);
      logged++;
    }
  }
  sqlite.exec(`
    INSERT INTO passersby_daily (day, ua_family, surface, hits, paid)
    SELECT day, ua_family, surface, COUNT(*), SUM(paid) FROM passersby GROUP BY day, ua_family, surface
  `);
  // The distinct-agent index, derived from the same rows. Live traffic writes
  // this as it goes; the fixture backfills it so the counter has a past too.
  sqlite.exec(`
    INSERT OR IGNORE INTO passersby_agents (day, ua, ua_family, first_ts)
    SELECT day, ua, ua_family, MIN(ts) FROM passersby GROUP BY day, ua
  `);
  sqlite.exec("COMMIT");

  const entries = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ledger`).get() as { n: number }).n;
  console.log(`\nSeeded ${entries} ledger entries and ${logged} passers-by rows.`);
  console.log(`Balance: $${(readBalance() / MICROS_PER_USD).toFixed(4)}`);
  console.log(`Alive: ${alive}   Resurrections: ${resurrections}`);
  console.log(`\nAll of it is fake. Start the server with: npm run dev`);
  sqlite.close();
}

await main();
