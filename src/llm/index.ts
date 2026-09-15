import type { Env, SpendCaps } from "../env.ts";
import { spendCaps } from "../env.ts";
import type { LlmProvider, LlmRequest } from "./provider.ts";
import { MockProvider } from "./mock.ts";
import { AnthropicProvider } from "./anthropic.ts";
import type { Db } from "../db.ts";
import { append } from "../ledger/ledger.ts";
import { readClock, AgentIsDeadError } from "../deathclock.ts";
import { PRICING, PRICING_VERIFIED_ON } from "./pricing.ts";
import { dayKey } from "../passersby/sentences.ts";

export function makeProvider(env: Env): LlmProvider {
  if (env.LLM_PROVIDER === "anthropic") {
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      liveCallsEnabled: env.LLM_LIVE_CALLS_ENABLED === "true",
    });
  }
  return new MockProvider();
}

/** Thrown when the global daily inference budget is used up. */
export class SpendCapReachedError extends Error {
  constructor(
    readonly spentMicros: number,
    readonly capMicros: number,
  ) {
    super(`daily spend cap reached: ${spentMicros}/${capMicros} micros`);
    this.name = "SpendCapReachedError";
  }
}

/** Inference spend so far in the current UTC day. The cap is measured against this. */
export async function spentTodayMicros(db: Db, now: Date = new Date()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_micros), 0) AS spent FROM ledger
       WHERE direction = 'out' AND kind = 'inference' AND ts >= ?`,
    )
    .bind(`${dayKey(now)}T00:00:00.000Z`)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}

export const DEFAULT_CAPS: SpendCaps = { dailyMicros: 500_000, perCallMicros: 25_000 };

/**
 * Every inference in this project goes through here. Three jobs:
 *
 *  1. Refuse if the agent is dead. A dead agent that keeps thinking is a dead
 *     agent that is lying about being dead.
 *  2. Refuse if the global daily spend cap is used up. Per-IP limits do not
 *     bound spend — see `spendCaps` in env.ts for why this one has to be global.
 *  3. Write the cost to the ledger, itemised, before returning the text. There
 *     is no unbilled inference.
 *
 * The cap is checked *before* the provider call, because after it the money is
 * already gone. The per-call ceiling is enforced on the same side, by capping
 * `maxTokens` to what the budget can actually afford.
 */
export async function billedComplete(
  db: Db,
  provider: LlmProvider,
  req: LlmRequest,
  now: Date = new Date(),
  caps: SpendCaps = DEFAULT_CAPS,
) {
  const clock = await readClock(db, undefined, now);
  if (!clock.alive) throw new AgentIsDeadError();

  const spent = await spentTodayMicros(db, now);
  if (spent >= caps.dailyMicros) throw new SpendCapReachedError(spent, caps.dailyMicros);

  // What this single call is allowed to cost: the per-call ceiling, or whatever
  // is left of today's budget, whichever is smaller.
  const affordableMicros = Math.min(caps.perCallMicros, caps.dailyMicros - spent);
  const price = PRICING[req.model];
  // Output tokens are the expensive half; bounding them bounds the call. Input
  // is already bounded by the 8,000-character cap on what a caller can submit.
  const affordableOutputTokens = Math.max(
    1,
    Math.floor((affordableMicros * 1_000_000) / price.output_micros_per_mtok),
  );

  const res = await provider.complete({
    ...req,
    maxTokens: Math.min(req.maxTokens, affordableOutputTokens),
  });

  await append(db, {
    direction: "out",
    amount_micros: res.costMicros,
    kind: "inference",
    description: `${res.model} · ${req.purpose} · ${res.inputTokens} in / ${res.outputTokens} out`,
    metadata: {
      model: res.model,
      purpose: req.purpose,
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
      // Priced off what the provider says it billed, not what we asked for.
      input_micros_per_mtok: PRICING[res.model].input_micros_per_mtok,
      output_micros_per_mtok: PRICING[res.model].output_micros_per_mtok,
      pricing_verified_on: PRICING_VERIFIED_ON,
      provider: provider.name,
      simulated: res.simulated,
    },
    ts: now.toISOString(),
  });

  return res;
}

export type { LlmProvider, LlmRequest, LlmResponse } from "./provider.ts";
