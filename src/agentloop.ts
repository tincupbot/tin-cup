import type { Db } from "./db.ts";
import type { Env } from "./env.ts";
import { clockConfig, spendCaps } from "./env.ts";
import { readClock, reconcileLifecycle, formatDeathDate } from "./deathclock.ts";
import { formatUsd, formatRate } from "./money.ts";
import { summary, dayKey, prunePassersby } from "./passersby/counter.ts";
import { busksSince } from "./crowd.ts";
import { rebuildLedgerState } from "./ledger/state.ts";
import { pruneRateLimits } from "./ratelimit.ts";
import { billedComplete, makeProvider, SpendCapReachedError, ProviderUnavailableError } from "./llm/index.ts";
import { routineModel } from "./llm/pricing.ts";
import { AgentIsDeadError } from "./deathclock.ts";
import * as copy from "./copy.ts";

/**
 * The scheduled run.
 *
 * IT DOES NOT SEND ANYTHING. The daily post is written to the local `outbox`
 * table and stays there. There is no X account, no API client, and no network
 * call in this file. Posting is a separate, separately-approved step — see
 * README, "Before this can go live".
 */

export type LoopResult = {
  ran_at: string;
  alive: boolean;
  lifecycle_change: "died" | "resurrected" | null;
  balance_micros: number;
  performances_run: number;
  post_written: boolean;
  post_body: string | null;
  skipped_reason: string | null;
};

export async function runAgentLoop(db: Db, env: Env, now: Date = new Date()): Promise<LoopResult> {
  // No schema work here. The schema is applied by `wrangler d1 migrations
  // apply`, out of band, and a scheduled run that silently created tables would
  // be a scheduled run that could silently create the *wrong* tables.

  // 1. Square the recorded state with what the balance actually says.
  const lifecycle = await reconcileLifecycle(db, now);
  const clock = await readClock(db, clockConfig(env), now);

  const result: LoopResult = {
    ran_at: now.toISOString(),
    alive: clock.alive,
    lifecycle_change: lifecycle.changed,
    balance_micros: clock.balance_micros,
    performances_run: 0,
    post_written: false,
    post_body: null,
    skipped_reason: null,
  };

  // Housekeeping that must not happen on a request path: trim the rate-limit
  // rows, prune the raw passers-by log to its retention window, and rebuild the
  // materialised ledger summary from scratch so a day of incremental updates
  // gets checked against the real thing once a day.
  await pruneRateLimits(db, now);
  await prunePassersby(db, now);
  await rebuildLedgerState(db);

  if (!clock.alive) {
    result.skipped_reason = "dead — no inference, no post";
    return result;
  }

  // 2. Queued performances. Each one costs money and can be the thing that
  //    kills it, which is correct: it should die mid-sentence, doing the job.
  const provider = makeProvider(env);
  const { results: queued } = await db
    .prepare(`SELECT id, kind, subject FROM performances WHERE status = 'queued' ORDER BY created_at ASC LIMIT 5`)
    .all<{ id: string; kind: string; subject: string }>();

  const caps = spendCaps(env);

  for (const p of queued) {
    try {
      const res = await billedComplete(
        db,
        provider,
        {
          model: routineModel(env.LLM_PROVIDER),
          system: SYSTEM_PROMPT,
          prompt: p.subject,
          maxTokens: 600,
          purpose: p.kind,
        },
        now,
        caps,
      );
      await db
        .prepare(`UPDATE performances SET output = ?, status = 'done' WHERE id = ?`)
        .bind(res.text, p.id)
        .run();
      result.performances_run++;
    } catch (err) {
      if (err instanceof AgentIsDeadError) {
        await reconcileLifecycle(db, now);
        result.alive = false;
        result.skipped_reason = "ran out of money mid-queue";
        return result;
      }
      if (err instanceof SpendCapReachedError) {
        // Leave the rest queued rather than failing them. The budget resets at
        // midnight UTC and the work is still wanted; it just isn't affordable
        // right now. The daily post below costs nothing, so it still goes out.
        result.skipped_reason = "daily spend cap reached — remaining performances left queued";
        break;
      }
      if (err instanceof ProviderUnavailableError) {
        // Our plumbing, not this request. Marking the performance `failed`
        // would blame a visitor's subject for an empty API account and lose the
        // work permanently — there is no requeue path. Leave everything queued
        // and stop trying; the next run will find the same queue.
        result.skipped_reason = `provider unavailable (${err.reason}) — performances left queued, nothing billed`;
        break;
      }
      await db.prepare(`UPDATE performances SET status = 'failed' WHERE id = ?`).bind(p.id).run();
    }
  }

  // 3. The daily post. Written locally. Not sent.
  const post = await composeDailyPost(db, env, now);
  const day = dayKey(now);
  await db
    .prepare(
      `INSERT INTO outbox (created_at, day, channel, body, status) VALUES (?, ?, 'x', ?, 'unsent')
       ON CONFLICT(day, channel) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
    )
    .bind(now.toISOString(), day, post)
    .run();

  result.post_written = true;
  result.post_body = post;

  // 4. The post itself may have been the spend that finished it.
  const after = await reconcileLifecycle(db, now);
  if (after.changed === "died") {
    result.alive = false;
    result.lifecycle_change = "died";
  }
  const finalClock = await readClock(db, clockConfig(env), now);
  result.balance_micros = finalClock.balance_micros;

  return result;
}

const SYSTEM_PROMPT = [
  "You are Tin Cup, a program that pays for its own inference out of donations.",
  "Dry, self-aware, a little dignified. Never pitiful. Never imply human hardship — nobody goes hungry if you fail, you just stop.",
  "Never use the word charity. Never chase anyone; you do not send messages, you are read.",
  "Short sentences. The numbers do the work.",
].join(" ");

/**
 * The daily post: the same four numbers, every day. Consistency is what makes a
 * format followable, so the shape is fixed and only the figures move.
 */
export async function composeDailyPost(db: Db, env: Env, now: Date = new Date()): Promise<string> {
  const clock = await readClock(db, clockConfig(env), now);
  const counter = await summary(db, now);

  // Count the day's turns from the ledger rather than estimating. Every number
  // in a public post has to be one somebody could check.
  //
  // `json_extract` on the metadata column, not `LIKE '%"purpose":"roast"%'`.
  // The LIKE was a full table scan and it was also wrong: it matched the
  // substring anywhere in the blob, including inside a subject a visitor had
  // pasted in, so a stranger could inflate a number in a public post by typing
  // it into the busk box.
  const busks = await busksSince(db, new Date(now.getTime() - 86_400_000).toISOString());

  const buskLine =
    busks.count === 0
      ? "Nobody asked for anything today."
      : `Performed ${busks.count} ${busks.count === 1 ? "turn" : "turns"} for strangers, for ${formatUsd(busks.spent_micros)}.`;

  return [
    `${formatUsd(clock.balance_micros)} left.`,
    clock.days_left === null
      ? "No days left."
      : `${clock.days_left.toFixed(1)} days at ${formatRate(clock.burn_micros_per_day)}. Dies ${formatDeathDate(clock.dies_at, now)}.`,
    buskLine,
    counter.today_line,
  ].join("\n");
}

export { copy };
