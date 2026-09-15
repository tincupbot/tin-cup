/**
 * MODEL PRICING — SINGLE SOURCE OF TRUTH.
 *
 * Verified 2026-09-15 against the bundled `claude-api` skill reference table
 * (that table is itself marked "cached: 2026-06-24"). Prices are list rates for
 * the first-party Anthropic API, in USD per million tokens.
 *
 *   >>> RE-VERIFY BEFORE ANY REAL SPEND. <<<
 *
 * Nothing in this repo makes a paid API call today — MockProvider is the only
 * wired-up provider — so a stale number here currently costs nothing. The moment
 * `LLM_LIVE_CALLS_ENABLED` is flipped, a stale number here means the public
 * ledger is publishing wrong figures, which is the one failure this project
 * cannot survive. Check https://www.anthropic.com/pricing and update the date.
 */

import { MICROS_PER_USD, tokenCostMicros } from "../money.ts";

export const PRICING_VERIFIED_ON = "2026-09-15";
export const PRICING_SOURCE = "claude-api skill reference table (cached 2026-06-24)";

export type ModelId = "claude-haiku-4-5" | "claude-opus-5";

export type ModelPrice = {
  /** Micro-dollars per million input tokens. */
  input_micros_per_mtok: number;
  /** Micro-dollars per million output tokens. */
  output_micros_per_mtok: number;
  context_window: number;
  note: string;
};

export const PRICING: Record<ModelId, ModelPrice> = {
  // $1.00 / $5.00 per MTok.
  "claude-haiku-4-5": {
    input_micros_per_mtok: 1 * MICROS_PER_USD,
    output_micros_per_mtok: 5 * MICROS_PER_USD,
    context_window: 200_000,
    note: "Routine chatter: roasts, daily posts, replies. The workhorse.",
  },
  // $5.00 / $25.00 per MTok.
  "claude-opus-5": {
    input_micros_per_mtok: 5 * MICROS_PER_USD,
    output_micros_per_mtok: 25 * MICROS_PER_USD,
    context_window: 1_000_000,
    note: "Paid premium work only — commissions, the $5+ menu. Never free output.",
  },
};

/** The model mix, per spec: Haiku for everything free, Opus only when someone paid. */
export const ROUTINE_MODEL: ModelId = "claude-haiku-4-5";
export const PREMIUM_MODEL: ModelId = "claude-opus-5";

export function costMicros(model: ModelId, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  return (
    tokenCostMicros(inputTokens, price.input_micros_per_mtok) +
    tokenCostMicros(outputTokens, price.output_micros_per_mtok)
  );
}
