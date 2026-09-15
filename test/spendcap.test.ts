import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.ts";
import { billedComplete, spentTodayMicros, SpendCapReachedError, makeProvider } from "../src/llm/index.ts";
import { MockProvider } from "../src/llm/mock.ts";
import { AnthropicProvider } from "../src/llm/anthropic.ts";
import { append, allEntries } from "../src/ledger/ledger.ts";
import { AgentIsDeadError } from "../src/deathclock.ts";
import { ROUTINE_MODEL, costMicros, PRICING } from "../src/llm/pricing.ts";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/llm/provider.ts";
import { spendCaps } from "../src/env.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: ROUTINE_MODEL,
  system: "you are a test",
  prompt: "roast this",
  maxTokens: 600,
  purpose: "roast",
  ...over,
});

async function funded() {
  const db = await freshDb();
  await append(db, {
    direction: "in",
    amount_micros: 50_000_000,
    kind: "startup_capital",
    description: "seed",
    ts: NOW.toISOString(),
  });
  return db;
}

/** Records what it was asked for, so the cap's effect on maxTokens is observable. */
class SpyProvider implements LlmProvider {
  readonly name = "spy";
  calls: LlmRequest[] = [];
  constructor(private readonly cost: number) {}
  async complete(r: LlmRequest): Promise<LlmResponse> {
    this.calls.push(r);
    return {
      text: "roasted",
      inputTokens: 100,
      outputTokens: 100,
      model: r.model,
      costMicros: this.cost,
      simulated: true,
    };
  }
}

describe("spentTodayMicros", () => {
  it("counts only today's inference, not donations and not yesterday", async () => {
    const db = await funded();
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "today", ts: NOW.toISOString() });
    await append(db, {
      direction: "out",
      amount_micros: 9_000_000,
      kind: "inference",
      description: "yesterday",
      ts: "2026-09-14T23:59:59.000Z",
    });
    await append(db, { direction: "out", amount_micros: 500, kind: "hosting", description: "not inference", ts: NOW.toISOString() });

    expect(await spentTodayMicros(db, NOW)).toBe(1_000);
  });

  it("counts from midnight UTC, including the first millisecond of the day", async () => {
    const db = await funded();
    await append(db, {
      direction: "out",
      amount_micros: 7,
      kind: "inference",
      description: "just after midnight",
      ts: "2026-09-15T00:00:00.000Z",
    });
    expect(await spentTodayMicros(db, NOW)).toBe(7);
  });
});

describe("billedComplete", () => {
  it("bills every call to the ledger, itemised", async () => {
    const db = await funded();
    const res = await billedComplete(db, new MockProvider(), req(), NOW, spendCaps({} as never));

    const entries = (await allEntries(db)).filter((e) => e.kind === "inference");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amount_micros).toBe(res.costMicros);
    expect(entries[0]!.metadata).toMatchObject({ purpose: "roast", simulated: true, model: ROUTINE_MODEL });
  });

  it("refuses once the day's global budget is used up", async () => {
    const db = await funded();
    const caps = { dailyMicros: 10_000, perCallMicros: 25_000 };
    await append(db, {
      direction: "out",
      amount_micros: 10_000,
      kind: "inference",
      description: "the day's budget",
      ts: NOW.toISOString(),
    });

    await expect(billedComplete(db, new MockProvider(), req(), NOW, caps)).rejects.toThrow(SpendCapReachedError);
  });

  it("refuses before calling the provider, because after it the money is gone", async () => {
    const db = await funded();
    const spy = new SpyProvider(1_000);
    await append(db, { direction: "out", amount_micros: 10_000, kind: "inference", description: "spent", ts: NOW.toISOString() });

    await expect(
      billedComplete(db, spy, req(), NOW, { dailyMicros: 10_000, perCallMicros: 25_000 }),
    ).rejects.toThrow(SpendCapReachedError);
    expect(spy.calls).toHaveLength(0);
  });

  it("holds the line against a caller hammering it from many addresses", async () => {
    // Per-IP rate limiting does not bound spend; an attacker rotating addresses
    // walks through it. This cap is the thing that actually stops the bleeding.
    const db = await funded();
    const caps = { dailyMicros: 20_000, perCallMicros: 5_000 };
    let refused = 0;

    for (let i = 0; i < 50; i++) {
      try {
        await billedComplete(db, new SpyProvider(5_000), req(), NOW, caps);
      } catch (err) {
        if (err instanceof SpendCapReachedError) refused++;
        else throw err;
      }
    }

    expect(refused).toBe(46);
    expect(await spentTodayMicros(db, NOW)).toBeLessThanOrEqual(caps.dailyMicros);
  });

  it("shrinks maxTokens to what the remaining budget can pay for", async () => {
    const db = await funded();
    const spy = new SpyProvider(10);
    const perCall = 5_000;

    await billedComplete(db, spy, req({ maxTokens: 100_000 }), NOW, { dailyMicros: 1_000_000, perCallMicros: perCall });

    const affordable = Math.floor((perCall * 1_000_000) / PRICING[ROUTINE_MODEL].output_micros_per_mtok);
    expect(spy.calls[0]!.maxTokens).toBe(affordable);
  });

  it("leaves a modest request alone", async () => {
    const db = await funded();
    const spy = new SpyProvider(10);
    await billedComplete(db, spy, req({ maxTokens: 50 }), NOW, { dailyMicros: 1_000_000, perCallMicros: 25_000 });
    expect(spy.calls[0]!.maxTokens).toBe(50);
  });

  it("refuses outright when the balance is gone, cap or no cap", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in", ts: NOW.toISOString() });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out", ts: NOW.toISOString() });

    await expect(billedComplete(db, new MockProvider(), req(), NOW, spendCaps({} as never))).rejects.toThrow(
      AgentIsDeadError,
    );
  });
});

describe("provider selection", () => {
  it("defaults to the mock, and only builds the Anthropic one when explicitly told to", () => {
    expect(makeProvider({} as never).name).toBe("mock");
    expect(makeProvider({ LLM_PROVIDER: "openai" } as never).name).toBe("mock");
    expect(makeProvider({ LLM_PROVIDER: "anthropic" } as never)).toBeInstanceOf(AnthropicProvider);
  });

  it("keeps the Anthropic provider inert without both switches", async () => {
    await expect(
      new AnthropicProvider({ apiKey: "sk-test", liveCallsEnabled: false }).complete(req()),
    ).rejects.toThrow(/LLM_LIVE_CALLS_ENABLED/);
    await expect(
      new AnthropicProvider({ apiKey: undefined, liveCallsEnabled: true }).complete(req()),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("pricing arithmetic", () => {
  it("rounds each side up separately, so a cost is never under-reported", () => {
    // One token of Haiku output is $0.000005, which rounds to 5 micros, not 0.
    expect(costMicros(ROUTINE_MODEL, 0, 1)).toBe(5);
    expect(costMicros(ROUTINE_MODEL, 1, 0)).toBe(1);
    expect(costMicros(ROUTINE_MODEL, 1_000_000, 1_000_000)).toBe(6_000_000);
  });
});
