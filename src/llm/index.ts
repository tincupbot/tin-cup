import type { Env, SpendCaps } from "../env.ts";
import type { LlmProvider, LlmRequest, ProviderFailure } from "./provider.ts";
import { ProviderUnavailableError } from "./provider.ts";
import { MockProvider } from "./mock.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAiProvider } from "./openai.ts";
import type { Db } from "../db.ts";
import { getState, setState } from "../db.ts";
import { append } from "../ledger/ledger.ts";
import { readClock, AgentIsDeadError } from "../deathclock.ts";
import { PRICING, PRICING_VERIFIED_ON } from "./pricing.ts";
import { dayKey } from "../passersby/sentences.ts";

/**
 * Mock is the default and stays the default.
 *
 * Both live providers are inert twice over: they need `LLM_PROVIDER` set to
 * their name *and* `LLM_LIVE_CALLS_ENABLED === "true"` *and* a key. Anything
 * unrecognised falls back to the mock rather than erroring, because the failure
 * mode of a typo in config should be "no spend", never "spend on the wrong
 * thing".
 */
export function makeProvider(env: Env): LlmProvider {
  const liveCallsEnabled = env.LLM_LIVE_CALLS_ENABLED === "true";
  switch (env.LLM_PROVIDER) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, liveCallsEnabled });
    case "openai":
      return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY, liveCallsEnabled });
    default:
      return new MockProvider();
  }
}

// ---------------------------------------------------------------------------
// Whether the thing that sells tokens is currently selling us any.
// ---------------------------------------------------------------------------

/**
 * The ledger says whether Tin Cup can *afford* to think. This says whether it
 * can actually *do* it. They are different questions and, because donations and
 * inference credit live in two accounts with a human in between, they get
 * different answers — a balance with five days on it and an API account that
 * has been empty since Tuesday is a site telling a true number and a false
 * story.
 *
 * So the last provider outcome is recorded, and /health reports it and stops
 * returning 200 while it is bad. This is a status, not money: it lives in the
 * `state` table, never in the ledger. Nothing about a failed call belongs in
 * the books, because a failed call cost nothing.
 */
export const PROVIDER_STATUS_KEY = "provider_status";

export type ProviderStatus =
  | { ok: true; reason: null; detail: null; since: null }
  | { ok: false; reason: ProviderFailure; detail: string; since: string };

export const PROVIDER_OK: ProviderStatus = { ok: true, reason: null, detail: null, since: null };

export async function readProviderStatus(db: Db): Promise<ProviderStatus> {
  const raw = await getState(db, PROVIDER_STATUS_KEY);
  if (!raw) return PROVIDER_OK;
  try {
    const parsed = JSON.parse(raw) as ProviderStatus;
    return parsed.ok === false ? parsed : PROVIDER_OK;
  } catch {
    return PROVIDER_OK;
  }
}

async function noteProviderFailure(db: Db, err: ProviderUnavailableError, now: Date): Promise<void> {
  // `err.detail` is ours — a status code and a classification, never the
  // provider's response body, which can name the account.
  const status: ProviderStatus = {
    ok: false,
    reason: err.reason,
    detail: err.detail,
    since: now.toISOString(),
  };
  await setState(db, PROVIDER_STATUS_KEY, JSON.stringify(status));
}

/** Clear the flag, but only if it is set: the happy path should not write. */
async function noteProviderOk(db: Db): Promise<void> {
  if ((await readProviderStatus(db)).ok) return;
  await setState(db, PROVIDER_STATUS_KEY, JSON.stringify(PROVIDER_OK));
}

/** Thrown when the global daily inference budget is used up. */
export class SpendCapReachedError extends Error {
  readonly spentMicros: number;
  readonly capMicros: number;

  constructor(spentMicros: number, capMicros: number) {
    super(`daily spend cap reached: ${spentMicros}/${capMicros} micros`);
    this.name = "SpendCapReachedError";
    this.spentMicros = spentMicros;
    this.capMicros = capMicros;
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

  let res;
  try {
    res = await provider.complete({
      ...req,
      maxTokens: Math.min(req.maxTokens, affordableOutputTokens),
    });
  } catch (err) {
    // Nothing is appended: a call that did not complete cost nothing, and an
    // entry for it would be an invented number. The outage is recorded outside
    // the books so the rest of the site can stop claiming to be able to think.
    if (err instanceof ProviderUnavailableError) await noteProviderFailure(db, err, now);
    throw err;
  }

  await noteProviderOk(db);

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

export type { LlmProvider, LlmRequest, LlmResponse, ProviderFailure } from "./provider.ts";
export { ProviderUnavailableError } from "./provider.ts";
