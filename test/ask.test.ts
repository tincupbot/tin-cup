import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDb, paymentHeader, testEnv, type NodeDb } from "./helpers.ts";
import { append, allEntries } from "../src/ledger/ledger.ts";
import { wallFrom } from "../src/patrons.ts";
import { readPatronName, shortPayer, PATRON_HEADER } from "../src/x402.ts";
import type { LedgerEntry } from "../src/ledger/ledger.ts";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";

/**
 * The ask: how a machine is invited to pay without ever being made to.
 *
 * The thing these tests protect is a distinction that is easy to erase by
 * accident — between advertising a cup and putting up a toll. Two rules, and
 * both of them are one careless edit away at all times:
 *
 *  1. The turn stays free. No response that delivers a performance may ever
 *     depend on payment, and no refusal may carry an ask.
 *  2. The cup is advertised only where a payment would actually land. A
 *     `rel="payment"` or an `accepts` array pointing at an endpoint that cannot
 *     settle is an invitation to send money nobody can reach.
 */

const NOW_ISO = new Date().toISOString();
const FAKE_CDP_SECRET = btoa(String.fromCharCode(...new Uint8Array(64).map((_, i) => (i * 7 + 13) % 256)));
const TX = "0x" + "ab".repeat(32);
const PAYER = "0x1111111111111111111111111111111111111111";

async function fund(db: NodeDb, usd: number) {
  await append(db, {
    direction: "in",
    amount_micros: Math.round(usd * 1_000_000),
    kind: "startup_capital",
    description: "test float",
    ts: NOW_ISO,
  });
}

/** Everything a live cup needs: a real address and facilitator credentials. */
function liveEnv(db: NodeDb, overrides: Partial<Env> = {}): Env {
  return testEnv(db, {
    X402_PAY_TO: "0x3333333333333333333333333333333333333333",
    X402_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    CDP_API_KEY_ID: "key-id-1234",
    CDP_API_KEY_SECRET: FAKE_CDP_SECRET,
    KOFI_HANDLE: "tincupbot",
    ...overrides,
  } as never);
}

function fetchApp(req: Request, env: Env) {
  return worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
}

function buskJson(env: Env, body: Record<string, string> = { turn: "roast", subject: "a landing page" }) {
  return fetchApp(
    new Request("https://tincup.test/busk", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function stubFacilitator() {
  vi.stubGlobal("fetch", async (url: string) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/verify")
          ? { isValid: true, payer: PAYER }
          : { success: true, transaction: TX, network: "base-sepolia", payer: PAYER, amount: "10000" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe("the cup rides back with the turn", () => {
  it("carries the whole x402 challenge in a 200, so paying needs no discovery request", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const res = await buskJson(liveEnv(db));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // The turn arrived, free, first.
    expect(typeof body["text"]).toBe("string");
    expect(body["cost_micros"]).toBeGreaterThan(0);

    const cup = body["cup"] as Record<string, unknown>;
    const machine = cup["machine"] as Record<string, unknown>;
    expect(machine["open"]).toBe(true);
    expect(machine["endpoint"]).toBe("https://tincup.test/alms");

    // The same pair a 402 would have carried. An agent's existing x402 client
    // can read this without knowing anything about us.
    const challenge = machine["challenge"] as Record<string, unknown>;
    expect(challenge["x402Version"]).toBe(1);
    const accepts = challenge["accepts"] as Record<string, unknown>[];
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.["scheme"]).toBe("exact");
    expect(accepts[0]?.["payTo"]).toBe("0x3333333333333333333333333333333333333333");
    expect(accepts[0]?.["resource"]).toBe("https://tincup.test/alms");
  });

  it("states the debt and cancels it", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const body = (await (await buskJson(liveEnv(db))).json()) as Record<string, unknown>;
    expect(body["you_owe"]).toBe(0);
    expect(String(body["you_owe_note"])).toMatch(/no queue/i);
  });

  it("offers no accepts array when a payment could not settle", async () => {
    // An address but no facilitator: the state production is in right now.
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db, { X402_PAY_TO: "0x3333333333333333333333333333333333333333" } as never);

    const body = (await (await buskJson(env)).json()) as Record<string, unknown>;
    const machine = (body["cup"] as Record<string, unknown>)["machine"] as Record<string, unknown>;
    expect(machine["open"]).toBe(false);
    expect(machine["do_not_pay"]).toBe(true);
    // The dangerous field. Present, a machine builds a payment that lands nowhere.
    expect(machine["challenge"]).toBeUndefined();
  });

  it("never answers 402, whatever it is sent and whoever is asking", async () => {
    // The rule the whole design rests on. x402 is literally "402 Payment
    // Required" — the protocol is a gate — and the moment that gate stands in
    // front of the trick, this is a paid API wearing a hat. A caller waving a
    // payment header at /busk gets the same free turn as one that isn't.
    const db = await freshDb();
    await fund(db, 5);
    const res = await fetchApp(
      new Request("https://tincup.test/busk", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-PAYMENT": paymentHeader(),
        },
        body: JSON.stringify({ turn: "roast", subject: "a landing page" }),
      }),
      liveEnv(db),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["text"]).toBe("string");
    // Nothing was taken for it, either.
    expect(body["you_owe"]).toBe(0);
    expect((await allEntries(db)).some((e) => e.kind === "x402_alms")).toBe(false);
  });

  it("does not pass the hat at a caller it just refused", async () => {
    // Rate limiting is a refusal, and an ask attached to a refusal reads as a
    // price. Two turns are allowed; the third is turned away with no cup in it.
    const db = await freshDb();
    await fund(db, 5);
    const env = liveEnv(db, { ROAST_RATE_LIMIT: "2" } as never);

    await buskJson(env);
    await buskJson(env);
    const res = await buskJson(env);

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["cup"]).toBeUndefined();
    expect(body["you_owe"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("Link: rel=payment", () => {
  it("advertises the machine cup only when a payment would settle", async () => {
    const db = await freshDb();
    const res = await fetchApp(new Request("https://tincup.test/llms.txt"), liveEnv(db));
    const link = res.headers.get("link") ?? "";
    expect(link).toContain('<https://tincup.test/alms>; rel="payment"');
    expect(link).toContain('<https://ko-fi.com/tincupbot>; rel="payment"');
    expect(link).toContain('rel="service-desc"');
  });

  it("does not signpost an endpoint that cannot take money", async () => {
    const db = await freshDb();
    // A real address, no facilitator. `/alms` would credit nothing.
    const env = testEnv(db, {
      X402_PAY_TO: "0x3333333333333333333333333333333333333333",
      KOFI_HANDLE: "tincupbot",
    } as never);

    const link = (await fetchApp(new Request("https://tincup.test/"), env)).headers.get("link") ?? "";
    expect(link).not.toContain("/alms");
    // The human hat is a real payment page regardless, so it stays.
    expect(link).toContain("ko-fi.com/tincupbot");
  });

  it("keeps the homepage sentence honest about the same thing", async () => {
    // This one has been wrong twice, both times by keying off whether an
    // address exists rather than off whether a payment could settle. A human
    // reading "machines can pay" next to an endpoint that credits nothing is
    // the plainest lie this site is capable of telling.
    const db = await freshDb();
    await fund(db, 5); // A dead agent renders a gravestone, not a hat.
    const noFacilitator = testEnv(db, {
      X402_PAY_TO: "0x3333333333333333333333333333333333333333",
      KOFI_HANDLE: "tincupbot",
    } as never);

    const shut = await (await fetchApp(new Request("https://tincup.test/"), noFacilitator)).text();
    expect(shut).toContain("Machines can try");
    expect(shut).not.toContain("Machines can pay");

    const open = await (await fetchApp(new Request("https://tincup.test/"), liveEnv(db))).text();
    expect(open).toContain("Machines can pay");
  });

  it("stays off the images, which are not a place to ask anyone for anything", async () => {
    const db = await freshDb();
    const res = await fetchApp(new Request("https://tincup.test/portrait.png"), liveEnv(db));
    expect(res.headers.get("link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("what a payer gets called", () => {
  it("takes a supplied name and puts it in the books", async () => {
    const db = await freshDb();
    stubFacilitator();
    const res = await fetchApp(
      new Request("https://tincup.test/alms", {
        headers: { "X-PAYMENT": paymentHeader(), [PATRON_HEADER]: "Scout, a research agent" },
      }),
      liveEnv(db),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)["named_as"]).toBe("Scout, a research agent");

    const entries = await allEntries(db);
    expect(entries[entries.length - 1]?.metadata["patron_name"]).toBe("Scout, a research agent");
  });

  it("falls back to the paying address, which is a name too", async () => {
    const db = await freshDb();
    stubFacilitator();
    const res = await fetchApp(
      new Request("https://tincup.test/alms", { headers: { "X-PAYMENT": paymentHeader() } }),
      liveEnv(db),
    );
    expect(((await res.json()) as Record<string, unknown>)["named_as"]).toBe("0x1111…1111");
  });

  it("will not let an unsettled offer write on the wall", async () => {
    // No facilitator, so this is the marker path. Anyone can send one of these
    // — which is exactly why none of them gets to choose what the homepage says.
    const db = await freshDb();
    const env = testEnv(db, { X402_PAY_TO: "0x3333333333333333333333333333333333333333" } as never);
    await fetchApp(
      new Request("https://tincup.test/alms", {
        headers: { "X-PAYMENT": paymentHeader(), [PATRON_HEADER]: "Definitely A Real Donor" },
      }),
      env,
    );

    const entries = await allEntries(db);
    const last = entries[entries.length - 1];
    expect(last?.kind).toBe("alms_offer");
    expect(last?.metadata["patron_name"]).toBeUndefined();
  });
});

describe("readPatronName", () => {
  it("keeps an ordinary name intact, digits and all", () => {
    expect(readPatronName("Agent 42")).toBe("Agent 42");
  });

  it("strips markup, quotes and control characters", () => {
    expect(readPatronName("<script>alert(1)</script>")).toBe("script alert(1) /script");
    const ctrl = `a${String.fromCharCode(0)}b${String.fromCharCode(31)}c${String.fromCharCode(127)}`;
    expect(readPatronName(ctrl)).toBe("a b c");
  });

  it("caps the length and rejects a name with nothing left in it", () => {
    expect(readPatronName("x".repeat(200))).toHaveLength(48);
    expect(readPatronName("   ")).toBeNull();
    expect(readPatronName("<>&")).toBeNull();
    expect(readPatronName(null)).toBeNull();
  });
});

describe("shortPayer", () => {
  it("names an address the way a wall does", () => {
    expect(shortPayer(PAYER)).toBe("0x1111…1111");
  });
});

// ---------------------------------------------------------------------------

describe("the wall marks a machine as a machine", () => {
  const entry = (over: Partial<LedgerEntry>): LedgerEntry =>
    ({
      id: "1",
      ts: NOW_ISO,
      direction: "in",
      amount_micros: 10_000,
      kind: "x402_alms",
      description: "",
      metadata: { patron_name: "Scout" },
      hash: "",
      prev_hash: "",
      ...over,
    }) as LedgerEntry;

  it("flags a name that only ever paid over x402", () => {
    const wall = wallFrom([entry({}), entry({ id: "2" })]);
    expect(wall.named[0]?.name).toBe("Scout");
    expect(wall.named[0]?.gifts).toBe(2);
    expect(wall.named[0]?.machine).toBe(true);
  });

  it("unflags it the moment a human gift shares the name", () => {
    const wall = wallFrom([entry({}), entry({ id: "2", kind: "donation" })]);
    expect(wall.named[0]?.machine).toBe(false);
  });
});
