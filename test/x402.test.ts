import { describe, expect, it } from "vitest";
import { freshDb, paymentHeader, testEnv } from "./helpers.ts";
import { checkPaymentHeader, toAtomicUnits, buildChallenge } from "../src/x402.ts";
import { x402Config } from "../src/env.ts";
import { readClock } from "../src/deathclock.ts";
import { append, allEntries, verifyLedger } from "../src/ledger/ledger.ts";
import worker from "../src/index.ts";

const CFG = x402Config({ X402_NETWORK: "base-sepolia", X402_PRICE_MICROS: "10000" } as never);

function decode(header: string): Record<string, unknown> {
  return JSON.parse(atob(header)) as Record<string, unknown>;
}

function reencode(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

describe("checkPaymentHeader", () => {
  it("accepts a well-formed payload and surfaces the payer and nonce", () => {
    const res = checkPaymentHeader(paymentHeader(), CFG);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(res.nonce).toMatch(/^nonce-/);
  });

  it("refuses a missing header without pretending it was malformed", () => {
    const res = checkPaymentHeader(null, CFG);
    expect(res).toEqual({ ok: false, error: "no_payment_header" });
  });

  it("refuses junk, bad base64 and non-objects", () => {
    for (const h of ["!!!not base64!!!", btoa("not json"), btoa('"a string"'), btoa("null")]) {
      const res = checkPaymentHeader(h, CFG);
      expect(res.ok).toBe(false);
    }
  });

  it("refuses the wrong version, scheme or network", () => {
    expect(checkPaymentHeader(paymentHeader({ x402Version: 2 }), CFG)).toMatchObject({ error: "invalid_x402_version" });
    expect(checkPaymentHeader(paymentHeader({ scheme: "upto" }), CFG)).toMatchObject({ error: "unsupported_scheme" });
    expect(checkPaymentHeader(paymentHeader({ network: "base" }), CFG)).toMatchObject({ error: "invalid_network" });
  });

  it("refuses a payer that is not an address, so the ledger cannot be graffitied", () => {
    // This is the field that ends up rendered in a public ledger description.
    for (const from of ["0xFORGERY", "CLICK-HERE-FREE-USDC", "", "0x123", "0x" + "z".repeat(40)]) {
      expect(checkPaymentHeader(paymentHeader({}, { from }), CFG), from).toMatchObject({
        error: "invalid_payer_address",
      });
    }
  });

  it("refuses an authorization outside its own validity window", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(
      checkPaymentHeader(paymentHeader({}, { validAfter: String(nowSec - 7200), validBefore: String(nowSec - 3600) }), CFG),
    ).toMatchObject({ error: "payment_expired" });
    expect(
      checkPaymentHeader(paymentHeader({}, { validAfter: String(nowSec + 3600), validBefore: String(nowSec + 7200) }), CFG),
    ).toMatchObject({ error: "payment_not_yet_valid" });
    expect(checkPaymentHeader(paymentHeader({}, { validBefore: "not-a-number" }), CFG)).toMatchObject({
      error: "invalid_validity_window",
    });
  });

  it("refuses an empty or oversized nonce", () => {
    expect(checkPaymentHeader(paymentHeader({}, { nonce: "   " }), CFG)).toMatchObject({ error: "invalid_nonce" });
    expect(checkPaymentHeader(paymentHeader({}, { nonce: "n".repeat(300) }), CFG)).toMatchObject({
      error: "invalid_nonce",
    });
  });

  it("refuses a payload missing the signature or the authorization", () => {
    const base = decode(paymentHeader()) as { payload: Record<string, unknown> };
    const noSig = { ...base, payload: { authorization: base.payload["authorization"] } };
    const noAuth = { ...base, payload: { signature: "0xabc" } };
    expect(checkPaymentHeader(reencode(noSig), CFG)).toMatchObject({ error: "invalid_payload" });
    expect(checkPaymentHeader(reencode(noAuth), CFG)).toMatchObject({ error: "invalid_payload" });
  });
});

describe("toAtomicUnits", () => {
  it("converts micro-dollars to asset atomic units", () => {
    // 10,000 micros is $0.01. USDC has 6 decimals, so that is 10,000 units.
    expect(toAtomicUnits(10_000, 6)).toBe("10000");
    expect(toAtomicUnits(10_000, 18)).toBe("10000000000000000");
    // In a 2-decimal asset, $0.01 is one whole atomic unit.
    expect(toAtomicUnits(10_000, 2)).toBe("1");
  });
});

describe("buildChallenge", () => {
  it("advertises the price and omits the error field when there isn't one", () => {
    const c = buildChallenge(CFG, "https://tincup.test/alms");
    expect(c.x402Version).toBe(1);
    expect(c.accepts[0]!.maxAmountRequired).toBe("10000");
    expect(c.accepts[0]!.scheme).toBe("exact");
    expect("error" in c).toBe(false);
    expect(buildChallenge(CFG, "r", "payment_expired").error).toBe("payment_expired");
  });
});

/**
 * The integration that matters. `/alms` is reachable by anyone and verifies no
 * signature, so the invariant under test is not "it works" but "a stranger
 * cannot move a number that anybody reads".
 */
describe("GET /alms", () => {
  async function seeded() {
    const db = await freshDb();
    await append(db, {
      direction: "in",
      amount_micros: 5_000_000,
      kind: "startup_capital",
      description: "seed",
    });
    return db;
  }

  const call = (env: ReturnType<typeof testEnv>, headers: Record<string, string> = {}) =>
    worker.fetch(new Request("https://tincup.test/alms", { headers }), env as never);

  it("challenges with 402 when there is no payment", async () => {
    const res = await call(testEnv(await seeded()));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: unknown[] };
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
  });

  it("records an accepted payload without crediting a single micro-dollar", async () => {
    const db = await seeded();
    const env = testEnv(db);
    // A fixed `now`, so `dies_at` is compared against the same instant on both
    // sides rather than drifting by the millisecond the request took.
    const now = new Date("2026-09-15T12:00:00.000Z");
    const before = await readClock(db, undefined, now);

    const res = await call(env, { "X-PAYMENT": paymentHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credited_micros: number; settled: boolean };
    expect(body.credited_micros).toBe(0);
    expect(body.settled).toBe(false);

    const after = await readClock(db, undefined, now);
    expect(after.balance_micros).toBe(before.balance_micros);
    expect(after.dies_at).toBe(before.dies_at);

    // It is still recorded — an offer is a real event, just not a real payment.
    const offers = (await allEntries(db)).filter((e) => e.kind === "alms_offer");
    expect(offers).toHaveLength(1);
    expect(offers[0]!.amount_micros).toBe(0);
    expect(offers[0]!.metadata["offered_micros"]).toBe(10_000);
    expect(offers[0]!.metadata["settled"]).toBe(false);
    expect(await verifyLedger(db)).toMatchObject({ valid: true });
  });

  it("refuses a replayed authorization", async () => {
    const db = await seeded();
    const env = testEnv(db);
    const header = paymentHeader();

    expect((await call(env, { "X-PAYMENT": header })).status).toBe(200);
    const second = await call(env, { "X-PAYMENT": header });
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "replayed_payment" });

    expect((await allEntries(db)).filter((e) => e.kind === "alms_offer")).toHaveLength(1);
  });

  it("cannot be used to keep a dying agent alive", async () => {
    // The original defect, stated as a test: hammer /alms and check the clock.
    const db = await seeded();
    const env = testEnv(db);
    const before = await readClock(db);

    for (let i = 0; i < 25; i++) {
      await call(env, { "X-PAYMENT": paymentHeader() });
    }

    const after = await readClock(db);
    expect(after.balance_micros).toBe(before.balance_micros);
    expect(after.total_in_micros).toBe(before.total_in_micros);
  });
});
