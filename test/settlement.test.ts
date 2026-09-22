import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDb, paymentHeader, testEnv, type NodeDb } from "./helpers.ts";
import { generateJwt, atomicToMicros } from "../src/facilitator.ts";
import { allEntries, verifyLedger, readLedgerState } from "../src/ledger/ledger.ts";
import { x402Config } from "../src/env.ts";
import worker from "../src/index.ts";

/** The entry just written. Throws rather than returning undefined, so a test
 *  that asserts against an empty ledger fails loudly instead of vacuously. */
async function lastEntry(db: NodeDb) {
  const entries = await allEntries(db);
  const last = entries[entries.length - 1];
  if (!last) throw new Error("ledger is empty");
  return last;
}

/** Net of the books, in micro-dollars. `LedgerState` keeps the two sides apart. */
async function balance(db: NodeDb): Promise<number> {
  const s = await readLedgerState(db);
  return s.total_in_micros - s.total_out_micros;
}

/**
 * The settlement path: the only code in this project that may turn a stranger's
 * HTTP request into a number on the homepage.
 *
 * Every test here is written from the same angle — what would have to be true
 * for money to be credited that did not arrive, or to arrive and not be
 * credited. Those are the two failures that matter. Everything else is tidiness.
 */

/** 64 bytes, base64: the shape CDP hands out. Seed is the first 32. Not a real key. */
const FAKE_CDP_SECRET = btoa(String.fromCharCode(...new Uint8Array(64).map((_, i) => (i * 7 + 13) % 256)));

const TX = "0x" + "ab".repeat(32);

function env(db: NodeDb, overrides: Record<string, string> = {}) {
  return testEnv(db, {
    X402_PAY_TO: "0x3333333333333333333333333333333333333333",
    X402_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    CDP_API_KEY_ID: "key-id-1234",
    CDP_API_KEY_SECRET: FAKE_CDP_SECRET,
    ...overrides,
  } as never);
}

/** `throws` stands in for an unreachable facilitator: a fetch that never replies. */
type Reply = { status?: number; body: unknown; throws?: never } | { throws: string };

/** Stubs the facilitator. Records what we sent so the wire shape is assertable. */
function stubFacilitator(replies: { verify?: Reply; settle?: Reply }) {
  const sent: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const which = String(url).endsWith("/verify") ? "verify" : "settle";
    sent.push({
      url: String(url),
      auth: String((init.headers as Record<string, string>)["authorization"] ?? ""),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const reply = replies[which];
    if (!reply) throw new Error(`no stub for ${which}`);
    if ("throws" in reply) throw new Error(reply.throws);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

const OK_VERIFY: Reply = { body: { isValid: true, payer: "0x1111111111111111111111111111111111111111" } };
const OK_SETTLE: Reply = {
  body: {
    success: true,
    transaction: TX,
    network: "base-sepolia",
    payer: "0x1111111111111111111111111111111111111111",
    amount: "10000",
  },
};

async function alms(db: NodeDb, e: ReturnType<typeof env>, header = paymentHeader()): Promise<Response> {
  return worker.fetch(new Request("https://tincup.test/alms", { headers: { "X-PAYMENT": header } }), e, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe("settlement credits the books", () => {
  it("credits a settled payment, with the transaction hash as the receipt", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });

    const before = await balance(db);
    const res = await alms(db, env(db));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["settled"]).toBe(true);
    expect(body["credited_micros"]).toBe(10_000);
    expect(body["transaction"]).toBe(TX);

    const entry = await lastEntry(db);
    expect(entry.kind).toBe("x402_alms");
    expect(entry.amount_micros).toBe(10_000);
    expect(entry.metadata["transaction"]).toBe(TX);
    expect(entry.metadata["settled"]).toBe(true);
    // Gross. Nothing has been deducted and nothing claims to have been.
    expect(entry.metadata["reconciled"]).toBe(false);

    expect(await balance(db)).toBe(before + 10_000);
    expect((await verifyLedger(db)).valid).toBe(true);
  });

  it("credits what the facilitator says arrived, not what we asked for", async () => {
    // The advertised price is $0.01. A payer who signed for more gets credited
    // for more: the books follow the chain, not our price list.
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: { body: { ...(OK_SETTLE.body as object), amount: "250000" } } });

    await alms(db, env(db));
    expect((await lastEntry(db)).amount_micros).toBe(250_000);
  });

  it("announces settlement in the X-PAYMENT-RESPONSE header, with the hash", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });

    const res = await alms(db, env(db));
    const decoded = JSON.parse(atob(res.headers.get("X-PAYMENT-RESPONSE") ?? "")) as Record<string, unknown>;
    expect(decoded["settled"]).toBe(true);
    expect(decoded["transaction"]).toBe(TX);
  });
});

describe("settlement refuses rather than inventing money", () => {
  it("does not credit when the facilitator declines the payment", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: { body: { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "no" } } });

    const res = await alms(db, env(db));
    expect(res.status).toBe(402);
    expect((await allEntries(db)).filter((e) => e.kind === "x402_alms")).toHaveLength(0);
    expect(await balance(db)).toBe(0);
  });

  /**
   * Written from a live 400 on 2026-09-22, not from the docs. CDP answers a
   * declined payment with HTTP 400 and the verdict in the body. The code used
   * to require a 200 before it would read that body, so every honest decline
   * reached the payer as "facilitator_error" — our outage, not their problem,
   * and the one field that would have let them fix it dropped.
   */
  it("passes on the facilitator's reason when a decline arrives as a 400", async () => {
    const db = await freshDb();
    stubFacilitator({
      verify: {
        status: 400,
        body: {
          isValid: false,
          invalidReason: "insufficient_funds",
          invalidMessage: "Payer balance is below the required amount.",
          payer: "0x1111111111111111111111111111111111111111",
        },
      },
    });

    const res = await alms(db, env(db));
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    // The payer's problem, named, so it is actionable.
    expect(body["error"]).toBe("insufficient_funds");
    expect(String(body["detail"])).toContain("below the required amount");
    expect(await balance(db)).toBe(0);
  });

  it("still calls a bodyless failure an outage rather than a decline", async () => {
    // The other half of the asymmetry: no verdict in the body means we do not
    // know, and "we do not know" is not the payer's fault.
    const db = await freshDb();
    stubFacilitator({ verify: { status: 500, body: { message: "upstream exploded" } } });

    const res = await alms(db, env(db));
    expect(res.status).toBe(402);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: "facilitator_error" });
  });

  it("does not take isValid:true from anything but a clean 200", async () => {
    // Bad news is believed whenever it is stated; good news has to arrive
    // properly, because good news is what leads to money moving.
    const db = await freshDb();
    stubFacilitator({
      verify: { status: 500, body: { isValid: true, payer: "0x1111111111111111111111111111111111111111" } },
      settle: OK_SETTLE,
    });

    const res = await alms(db, env(db));
    expect(res.status).toBe(402);
    expect(await balance(db)).toBe(0);
    expect((await allEntries(db)).filter((e) => e.kind === "x402_alms")).toHaveLength(0);
  });

  it("leaves the nonce unspent when verification fails, so an honest payer can retry", async () => {
    // Verification is free and moves nothing. Burning the authorization on a
    // rejection would punish a payer for our round trip.
    const db = await freshDb();
    const header = paymentHeader();
    stubFacilitator({ verify: { body: { isValid: false, invalidReason: "insufficient_funds" } } });
    await alms(db, env(db), header);

    vi.unstubAllGlobals();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });
    const retry = await alms(db, env(db), header);
    expect(retry.status).toBe(200);
  });

  it("does not credit when settlement fails on chain", async () => {
    const db = await freshDb();
    stubFacilitator({
      verify: OK_VERIFY,
      settle: { status: 400, body: { success: false, errorReason: "insufficient_funds", errorMessage: "broke" } },
    });

    const res = await alms(db, env(db));
    expect(res.status).toBe(502);
    expect((await res.json() as Record<string, unknown>)["credited_micros"]).toBe(0);
    expect(await balance(db)).toBe(0);
  });

  it("does not credit when the facilitator is unreachable", async () => {
    const db = await freshDb();
    stubFacilitator({
      verify: OK_VERIFY,
      settle: { throws: "network down" },
    });

    const res = await alms(db, env(db));
    expect(res.status).toBe(502);
    expect(await balance(db)).toBe(0);
  });

  it("refuses a success flag that arrives without a transaction hash", async () => {
    // The hash is the receipt. `success: true` on its own is a claim, and a
    // claim is not what the books are for.
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: { body: { success: true, network: "base-sepolia", payer: null } } });

    const res = await alms(db, env(db));
    expect(res.status).toBe(502);
    expect(await balance(db)).toBe(0);
  });

  it("credits a settled payment exactly once, however many times it is sent", async () => {
    const db = await freshDb();
    const header = paymentHeader();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });

    expect((await alms(db, env(db), header)).status).toBe(200);
    expect((await alms(db, env(db), header)).status).toBe(409);
    expect(await balance(db)).toBe(10_000);
  });
});

describe("settlement stays off unless both halves are configured", () => {
  it("records a zero-amount marker when there is a wallet but no facilitator", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });

    const res = await alms(db, env(db, { CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }));
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>)["settled"]).toBe(false);

    expect((await lastEntry(db)).kind).toBe("alms_offer");
    expect(await balance(db)).toBe(0);
  });

  it("records a zero-amount marker when there is a facilitator but no wallet", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });

    const res = await alms(db, env(db, { X402_PAY_TO: "0x" + "0".repeat(40) }));
    expect((await lastEntry(db)).kind).toBe("alms_offer");
    expect((await res.json() as Record<string, unknown>)["credited_micros"]).toBe(0);
  });

  it("is not settlement-ready in either half-configured state", () => {
    const wallet = { X402_PAY_TO: "0x3333333333333333333333333333333333333333" };
    const keys = { CDP_API_KEY_ID: "a", CDP_API_KEY_SECRET: "b" };
    expect(x402Config(wallet as never).settlementReady).toBe(false);
    expect(x402Config(keys as never).settlementReady).toBe(false);
    expect(x402Config({ ...wallet, ...keys } as never).settlementReady).toBe(true);
  });

  // A malformed payTo is the quiet version of having no wallet at all: it is
  // non-empty and non-zero, so every "is there an address" check passes, and
  // the money goes to somewhere nobody holds a key to. Shape is checked once,
  // where the config is read, so no caller has to remember to.
  it("treats a malformed pay-to address as no wallet at all", () => {
    const keys = { CDP_API_KEY_ID: "a", CDP_API_KEY_SECRET: "b" };
    const malformed = [
      "0x36Da95a2ddF715746f36132f515986f96e5ef83",      // 39 chars — one dropped
      "0x36Da95a2ddF715746f36132f515986f96e5ef83FF",    // 41 chars — one too many
      "36Da95a2ddF715746f36132f515986f96e5ef83F",       // no 0x
      "0x36Da95a2ddF715746f36132f515986f96e5ef83G",     // not hex
      "not an address",
      "",
      "   ",
    ];
    for (const payTo of malformed) {
      const cfg = x402Config({ X402_PAY_TO: payTo, ...keys } as never);
      expect(cfg.isPlaceholder, payTo).toBe(true);
      expect(cfg.settlementReady, payTo).toBe(false);
    }

    // The real one, and the same value with stray whitespace around it.
    const good = "0x36Da95a2ddF715746f36132f515986f96e5ef83F";
    for (const payTo of [good, `  ${good}\n`]) {
      const cfg = x402Config({ X402_PAY_TO: payTo, ...keys } as never);
      expect(cfg.isPlaceholder).toBe(false);
      expect(cfg.settlementReady).toBe(true);
      expect(cfg.payTo).toBe(good);
    }
  });
});

describe("the settlement attempt is recorded before its outcome is known", () => {
  it("leaves 'attempted' behind when settlement never reports back", async () => {
    // The Ko-fi lesson of 2026-09-22, as a test: an attempt whose outcome is
    // lost must still be visible, or it is indistinguishable from an attempt
    // that never happened. A row reading 'attempted' names the nonce to
    // reconcile against the chain.
    const db = await freshDb();
    stubFacilitator({
      verify: OK_VERIFY,
      settle: { throws: "timeout" },
    });

    await alms(db, env(db));
    const row = await db
      .prepare(`SELECT settlement FROM x402_nonces LIMIT 1`)
      .first<{ settlement: string }>();
    expect(row?.settlement).toMatch(/^failed:/);
  });

  it("records the settled ledger id on success", async () => {
    const db = await freshDb();
    stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });
    await alms(db, env(db));

    const row = await db.prepare(`SELECT settlement FROM x402_nonces LIMIT 1`).first<{ settlement: string }>();
    expect(row?.settlement).toMatch(/^settled:/);
  });
});

describe("CDP authentication", () => {
  it("signs a bearer token scoped to one method and path", async () => {
    const jwt = await generateJwt({ apiKeyId: "key-id-1234", apiKeySecret: FAKE_CDP_SECRET }, "POST", "/v2/x402/settle");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [h, p, sig] = parts as [string, string, string];
    const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;

    expect(header["alg"]).toBe("EdDSA");
    expect(header["kid"]).toBe("key-id-1234");
    expect(claims["iss"]).toBe("cdp");
    expect(claims["aud"]).toEqual(["cdp_service"]);
    expect(claims["uri"]).toBe("POST api.cdp.coinbase.com/platform/v2/x402/settle");
    // Short-lived by construction: a leaked token is good for two minutes.
    expect((claims["exp"] as number) - (claims["nbf"] as number)).toBe(120);
    expect(sig.length).toBeGreaterThan(80);
  });

  it("refuses a malformed key rather than sending an unsigned request", async () => {
    await expect(generateJwt({ apiKeyId: "x", apiKeySecret: btoa("too short") }, "POST", "/v2/x402/settle")).rejects.toThrow(
      /cdp_key_malformed/,
    );
  });

  it("sends v1 payloads to the v2 facilitator, with the bearer token attached", async () => {
    const db = await freshDb();
    const sent = stubFacilitator({ verify: OK_VERIFY, settle: OK_SETTLE });
    await alms(db, env(db));

    expect(sent.map((s) => s.url)).toEqual([
      "https://api.cdp.coinbase.com/platform/v2/x402/verify",
      "https://api.cdp.coinbase.com/platform/v2/x402/settle",
    ]);
    for (const call of sent) {
      expect(call.auth).toMatch(/^Bearer ey/);
      expect(call.body["x402Version"]).toBe(1);
      // The requirements we send must be the ones we advertised, or we would be
      // settling a payment against terms the payer never saw.
      expect((call.body["paymentRequirements"] as Record<string, unknown>)["payTo"]).toBe(
        "0x3333333333333333333333333333333333333333",
      );
      expect((call.body["paymentRequirements"] as Record<string, unknown>)["resource"]).toBe("https://tincup.test/alms");
    }
  });
});

/**
 * The preflight. It exists because every other test in this file drives a stub,
 * and a stub answers a JWT it never checked. These tests can only prove the
 * plumbing around the credential; whether the credential itself works is a
 * question with exactly one honest answer, and it comes from Coinbase.
 */
describe("the facilitator preflight", () => {
  /** Stubs GET /supported. Records the method, because the JWT is scoped to it. */
  function stubSupported(reply: { status?: number; body: unknown }) {
    const sent: { url: string; method: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({
        url: String(url),
        method: String(init.method ?? "GET"),
        auth: String((init.headers as Record<string, string>)["authorization"] ?? ""),
      });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    });
    return sent;
  }

  const KINDS = {
    kinds: [
      { x402Version: 1, scheme: "exact", network: "base" },
      { x402Version: 1, scheme: "exact", network: "base-sepolia" },
    ],
  };

  async function preflight(e: ReturnType<typeof env>, headers: Record<string, string>): Promise<Response> {
    return worker.fetch(new Request("https://tincup.test/__facilitator", { headers }), e, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as never);
  }

  const ADMIN = { "x-tincup-admin": "correct-horse" };

  it("is operator-only, and does not exist without a token", async () => {
    const db = await freshDb();
    stubSupported({ body: KINDS });
    // No ADMIN_TOKEN configured at all: the route must not admit to existing.
    expect((await preflight(env(db), ADMIN)).status).toBe(404);
    // Configured, wrong token.
    const e = env(db, { ADMIN_TOKEN: "correct-horse" });
    expect((await preflight(e, { "x-tincup-admin": "correct-horsf" })).status).toBe(404);
    expect((await preflight(e, {})).status).toBe(404);
  });

  it("reports the credential works and that our advertised pair is settleable", async () => {
    const db = await freshDb();
    const sent = stubSupported({ body: KINDS });
    const res = await preflight(env(db, { ADMIN_TOKEN: "correct-horse", X402_NETWORK: "base" }), ADMIN);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["authenticated"]).toBe(true);
    expect(body["advertised"]).toEqual({ scheme: "exact", network: "base" });
    expect(body["advertised_supported"]).toBe(true);

    // Read-only, authenticated, and scoped to the method it actually used.
    expect(sent[0]!.url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/supported");
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.auth).toMatch(/^Bearer ey/);
  });

  it("says do-not-switch-on when the facilitator does not settle what we advertise", async () => {
    const db = await freshDb();
    // A facilitator that settles on testnet only, while the challenge names base.
    stubSupported({ body: { kinds: [{ scheme: "exact", network: "base-sepolia" }] } });
    const res = await preflight(env(db, { ADMIN_TOKEN: "correct-horse", X402_NETWORK: "base" }), ADMIN);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body["advertised_supported"]).toBe(false);
    expect(String(body["note"])).toMatch(/Do not switch on/);
  });

  it("names a rejected credential as rejected, rather than as a generic outage", async () => {
    const db = await freshDb();
    stubSupported({ status: 401, body: { message: "Unauthorized" } });
    const res = await preflight(env(db, { ADMIN_TOKEN: "correct-horse" }), ADMIN);

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["reason"]).toBe("unauthorized");
  });

  /**
   * `?probe=verify`. The distinction it exists to draw is between "CDP says
   * this payment is bad" and "CDP says this request is malformed" — the second
   * would mean every real payment was malformed too.
   */
  describe("the verify probe", () => {
    /** Answers /supported, then /verify. Records both so the split is assertable. */
    function stubBoth(verify: { status?: number; body: unknown }) {
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        sent.push(String(url));
        const reply = String(url).endsWith("/supported") ? { status: 200, body: KINDS } : verify;
        return new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      });
      return sent;
    }

    const e = (db: NodeDb) => env(db, { ADMIN_TOKEN: "correct-horse", X402_NETWORK: "base" });

    it("does not run unless it is asked for", async () => {
      const db = await freshDb();
      const sent = stubBoth({ body: {} });
      const res = await preflight(e(db), ADMIN);

      expect(sent).toEqual(["https://api.cdp.coinbase.com/platform/v2/x402/supported"]);
      expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("probe");
    });

    it("reads a declined payment as the request shape being right", async () => {
      const db = await freshDb();
      const sent = stubBoth({ status: 200, body: { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" } });
      const res = await worker.fetch(
        new Request("https://tincup.test/__facilitator?probe=verify", { headers: ADMIN }),
        e(db),
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      );

      const probe = ((await res.json()) as Record<string, unknown>)["probe"] as Record<string, unknown>;
      expect(probe["request_shape_accepted"]).toBe(true);
      expect(probe["http_status"]).toBe(200);
      expect(probe["facilitator_said"]).toMatchObject({ invalidReason: "invalid_exact_evm_payload_signature" });
      // A declined payment is not an alarm. Being called valid would be.
      expect(probe).not.toHaveProperty("alarming");
      expect(sent[1]).toBe("https://api.cdp.coinbase.com/platform/v2/x402/verify");
      // It never settles, and it never touches the books.
      expect(sent.some((u) => u.endsWith("/settle"))).toBe(false);
      expect(await allEntries(db)).toHaveLength(0);
    });

    it("reads a rejected request as the request shape being wrong", async () => {
      const db = await freshDb();
      stubBoth({ status: 400, body: { message: "invalid request body" } });
      const res = await worker.fetch(
        new Request("https://tincup.test/__facilitator?probe=verify", { headers: ADMIN }),
        e(db),
        { waitUntil: () => {}, passThroughOnException: () => {} } as never,
      );

      const probe = ((await res.json()) as Record<string, unknown>)["probe"] as Record<string, unknown>;
      expect(probe["request_shape_accepted"]).toBe(false);
      expect(probe["http_status"]).toBe(400);
      // Verbatim: when CDP refuses the request, its reason is the finding.
      expect(probe["facilitator_said"]).toMatchObject({ message: "invalid request body" });
    });

    it("sends a payment no key could have signed, against the real requirements", async () => {
      const db = await freshDb();
      const bodies: Record<string, unknown>[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (String(url).endsWith("/supported")) {
          return new Response(JSON.stringify(KINDS), { status: 200 });
        }
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ isValid: false, invalidReason: "bad_signature" }), { status: 200 });
      });

      await worker.fetch(new Request("https://tincup.test/__facilitator?probe=verify", { headers: ADMIN }), e(db), {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as never);

      const sentBody = bodies[0]!;
      const payload = (sentBody["paymentPayload"] as Record<string, unknown>)["payload"] as Record<string, unknown>;
      // 65 zero bytes. No private key produces this, so a "valid" verdict on it
      // would mean the facilitator is not checking signatures at all.
      expect(payload["signature"]).toBe(`0x${"00".repeat(65)}`);
      // The requirements are the ones a real payer would be handed, not a
      // simplified stand-in — that is the half of the shape being tested.
      const req = sentBody["paymentRequirements"] as Record<string, unknown>;
      expect(req["payTo"]).toBe("0x3333333333333333333333333333333333333333");
      expect(req["resource"]).toBe("https://tincup.test/alms");
      expect(req["network"]).toBe("base");
    });
  });

  it("says which half of the credential is missing, and never what it is", async () => {
    const db = await freshDb();
    const res = await preflight(
      env(db, { ADMIN_TOKEN: "correct-horse", CDP_API_KEY_SECRET: "" }),
      ADMIN,
    );

    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toContain("no_credentials");
    expect(text).toContain('"key_id_set":true');
    expect(text).toContain('"key_secret_set":false');
    // The one thing this endpoint must never do.
    expect(text).not.toContain("key-id-1234");
    expect(text).not.toContain(FAKE_CDP_SECRET);
  });
});

describe("atomicToMicros", () => {
  it("converts USDC atomic units to micro-dollars", () => {
    expect(atomicToMicros("10000", 6)).toBe(10_000);
    expect(atomicToMicros("1000000", 6)).toBe(1_000_000);
  });

  it("refuses anything it cannot convert exactly, rather than rounding into the books", () => {
    expect(atomicToMicros("not a number", 6)).toBeNull();
    expect(atomicToMicros("-5", 6)).toBeNull();
    expect(atomicToMicros("1.5", 6)).toBeNull();
    // 18 decimals, not a whole number of micro-dollars.
    expect(atomicToMicros("1", 18)).toBeNull();
  });
});
