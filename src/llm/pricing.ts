/**
 * MODEL PRICING — SINGLE SOURCE OF TRUTH.
 *
 * Every number in this file is published. The ledger quotes the per-MTok rate
 * it billed at, in the metadata of every inference entry, and the whole project
 * is a claim that those numbers are real. A stale rate here is not a rounding
 * error; it is the one failure this project cannot survive.
 *
 *   >>> RE-VERIFY BEFORE ANY REAL SPEND. <<<
 *
 * That warning is no longer hypothetical. Local dev is still mock-only, but the
 * `production` environment in wrangler.toml sets `LLM_PROVIDER = "openai"` and
 * `LLM_LIVE_CALLS_ENABLED = "true"`, so these rates are what a deployed Tin Cup
 * bills real money against and publishes in the metadata of every inference
 * entry. A stale number here is now a false statement on a public page.
 *
 * Each block below records what was checked, where, and when. If a rate cannot
 * be verified against a first-party source, it does not go in this file.
 */

import { MICROS_PER_USD, tokenCostMicros } from "../money.ts";

export const PRICING_VERIFIED_ON = "2026-09-21";

export const PRICING_SOURCES: Record<string, { url: string; verified_on: string; note: string }> = {
  anthropic: {
    url: "https://www.anthropic.com/pricing",
    verified_on: "2026-09-15",
    note: "Taken from the bundled claude-api skill reference table, itself cached 2026-06-24. NOT re-checked against the live page — weaker provenance than the OpenAI block below. Anthropic is no longer the provider anything deploys with; these two rows exist because the mock prices against them and the fixture ledger is denominated in them. They must be re-verified before any live Anthropic call.",
  },
  openai: {
    url: "https://developers.openai.com/api/docs/pricing",
    verified_on: "2026-09-21",
    note: "RE-CHECKED LIVE 2026-09-21 against the per-model pages /api/docs/models/gpt-5.6-luna and /api/docs/models/gpt-5.6-terra, ahead of the first deploy with live calls switched on. Both rates UNCHANGED from the 2026-09-16 reading: Luna $0.20/$1.20, Terra $2.00/$12.00 per MTok, both 1,050,000 context. Standard tier, short-context rates. Nothing in the table below moved; only this date did.",
  },
};

/** Kept for the existing /health field and the ledger metadata. */
export const PRICING_SOURCE = PRICING_SOURCES["openai"]!.url;

export type AnthropicModelId = "claude-haiku-4-5" | "claude-opus-5";
export type OpenAiModelId = "gpt-5.6-luna" | "gpt-5.6-terra";
export type ModelId = AnthropicModelId | OpenAiModelId;

export type ModelPrice = {
  /** Micro-dollars per million input tokens. */
  input_micros_per_mtok: number;
  /** Micro-dollars per million output tokens. */
  output_micros_per_mtok: number;
  context_window: number;
  provider: "anthropic" | "openai";
  note: string;
};

export const PRICING: Record<ModelId, ModelPrice> = {
  // --- Anthropic. Verified 2026-09-15, provenance noted above. ---------------

  // $1.00 / $5.00 per MTok.
  "claude-haiku-4-5": {
    input_micros_per_mtok: 1 * MICROS_PER_USD,
    output_micros_per_mtok: 5 * MICROS_PER_USD,
    context_window: 200_000,
    provider: "anthropic",
    note: "Routine chatter: busks, daily posts, replies. The workhorse.",
  },
  // $5.00 / $25.00 per MTok.
  "claude-opus-5": {
    input_micros_per_mtok: 5 * MICROS_PER_USD,
    output_micros_per_mtok: 25 * MICROS_PER_USD,
    context_window: 1_000_000,
    provider: "anthropic",
    note: "Paid premium work only — commissions, the $5+ menu. Never free output.",
  },

  // --- OpenAI. Verified 2026-09-16, re-checked live 2026-09-21. -------------
  //
  // The 2026-09-21 re-check was the pre-deploy one: both model pages read
  // again, both rates identical, nothing below edited. The production provider.
  //
  // Two caveats that matter for a published ledger, both from the model pages:
  //
  //  1. These are SHORT-CONTEXT rates. A prompt over 272K input tokens is
  //     billed at 2x input and 1.5x output *for the whole request*. Nothing
  //     here can reach that — the busk caps subject text at 8,000 characters —
  //     but if that cap ever moves, this comment is the reason to revisit.
  //  2. Both models bill reasoning tokens as output tokens. The provider
  //     reports total output usage and that is what gets priced, so the ledger
  //     stays correct, but a reasoning-heavy turn costs more than its visible
  //     length suggests.

  // $0.20 / $1.20 per MTok. 1,050,000 context, 128,000 max output.
  "gpt-5.6-luna": {
    input_micros_per_mtok: 0.2 * MICROS_PER_USD,
    output_micros_per_mtok: 1.2 * MICROS_PER_USD,
    context_window: 1_050_000,
    provider: "openai",
    note: "OpenAI routine tier. Cost-sensitive, high-volume; roughly the old nano tier. Five times cheaper than Haiku 4.5 on both halves.",
  },
  // $2.00 / $12.00 per MTok. 1,050,000 context, 128,000 max output.
  "gpt-5.6-terra": {
    input_micros_per_mtok: 2 * MICROS_PER_USD,
    output_micros_per_mtok: 12 * MICROS_PER_USD,
    context_window: 1_050_000,
    provider: "openai",
    note: "OpenAI premium tier. Balances intelligence and cost; roughly the old mini tier. Chosen over gpt-5.6-sol ($4/$20) because Sol's rate is promotional through at least 2026-11-21, and a rate with an expiry date has no business in a published ledger.",
  },
};

/** The model mix, per provider: cheap for everything free, expensive only when someone paid. */
export const PROVIDER_MODELS: Record<string, { routine: ModelId; premium: ModelId }> = {
  anthropic: { routine: "claude-haiku-4-5", premium: "claude-opus-5" },
  openai: { routine: "gpt-5.6-luna", premium: "gpt-5.6-terra" },
  // The mock provider does no real work but does run the real pricing
  // arithmetic, so it needs a real model to price against. Anthropic's is the
  // historical default and keeps the fixture ledger comparable across builds.
  mock: { routine: "claude-haiku-4-5", premium: "claude-opus-5" },
};

export function modelsFor(provider: string | undefined): { routine: ModelId; premium: ModelId } {
  return PROVIDER_MODELS[provider ?? "mock"] ?? PROVIDER_MODELS["mock"]!;
}

export function routineModel(provider?: string): ModelId {
  return modelsFor(provider).routine;
}

export function premiumModel(provider?: string): ModelId {
  return modelsFor(provider).premium;
}

/** The historical defaults. Still the Anthropic pair; tests and the seeder use them. */
export const ROUTINE_MODEL: ModelId = PROVIDER_MODELS["anthropic"]!.routine;
export const PREMIUM_MODEL: ModelId = PROVIDER_MODELS["anthropic"]!.premium;

export function costMicros(model: ModelId, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  return (
    tokenCostMicros(inputTokens, price.input_micros_per_mtok) +
    tokenCostMicros(outputTokens, price.output_micros_per_mtok)
  );
}
