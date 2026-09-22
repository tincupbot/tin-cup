import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDb, testEnv, type NodeDb } from "./helpers.ts";
import { app } from "../src/index.ts";
import { append, allEntries } from "../src/ledger/ledger.ts";
import { readProviderStatus } from "../src/llm/index.ts";
import type { Env } from "../src/env.ts";
import * as copy from "../src/copy.ts";

/**
 * The states a deployed Tin Cup can be in that a local one cannot.
 *
 * Three of them, and each is a way for the site to be wrong about itself
 * rather than merely broken:
 *
 *   1. Machine payment is switched off. The failure to avoid is silence — a
 *      page that stops mentioning x402 rather than saying it is off.
 *   2. The account that buys tokens has stopped working while the ledger still
 *      shows days of balance. The failure to avoid is a 500, or worse, a
 *      cheerful 200 on /health.
 *   3. Dev fixture money somehow reaching a real deployment. The failure to
 *      avoid is a screenshot of invented donations with no banner on it.
 *
 * None of these is reachable from `npm run dev`, which is exactly why they are
 * tested here rather than discovered on the day.
 */

const NOW_ISO = new Date().toISOString();

async function fund(db: NodeDb, usd: number) {
  await append(db, {
    direction: "in",
    amount_micros: Math.round(usd * 1_000_000),
    kind: "startup_capital",
    description: "test float",
    ts: NOW_ISO,
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://tincup.test${path}`, { headers });
}

function post(path: string, body: Record<string, string>) {
  return new Request(`https://tincup.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

function postJson(path: string, body: unknown) {
  return new Request(`https://tincup.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. x402 switched off, as it is in production.
// ---------------------------------------------------------------------------

describe("machine payment switched off", () => {
  async function setup() {
    const db = await freshDb();
    await fund(db, 5);
    return { db, env: testEnv(db, { X402_ENABLED: "false" }) };
  }

  it("refuses at /alms with the reason, not a bare error", async () => {
    const { db, env } = await setup();
    const res = await app.fetch(get("/alms"), env);

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["accepting_payment"]).toBe(false);
    expect(body["do_not_pay"]).toBe(true);
    // It still counts you, and says so. That is the half of this that never
    // needed a wallet.
    expect(body["counted"]).toBe(true);
    // The reason is given, and it is a reason rather than a word. Asserted by
    // shape, not by phrasing: the wording changed on 2026-09-22 when the
    // reason stopped being "there is no address" and became "settlement is not
    // proven", and three tests failed for having memorised a sentence instead
    // of the claim it was making.
    expect(String(body["detail"])).toContain("switched off");
    expect(String(body["detail"]).length).toBeGreaterThan(80);

    // And nothing was written to the books for a payment that cannot happen.
    expect(await allEntries(db)).toHaveLength(1);
  });

  it("does not issue a challenge a machine could try to pay", async () => {
    const { env } = await setup();
    const body = await (await app.fetch(get("/alms"), env)).text();
    // The two fields an x402 client looks for. Their absence is the point:
    // there is nothing here to construct a payment against.
    expect(body).not.toContain("x402Version");
    expect(body).not.toContain("accepts");
  });

  // The disclosure is owed to the reader it concerns. A human deciding whether
  // to put $3 in a hat is not that reader, so the homepage stays quiet and
  // `/alms` answers in full to anything that actually asks.
  it("keeps the machine-payment apparatus off the homepage", async () => {
    const { env } = await setup();
    const html = await (await app.fetch(get("/"), env)).text();
    expect(html).not.toContain(copy.MACHINE_PAYMENT_OFF);
    expect(html).not.toContain("x402");
  });

  it("still says it in full to anything that asks /alms", async () => {
    const { env } = await setup();
    const body = await (await app.fetch(get("/alms"), env)).text();
    // The whole disclosure, verbatim, wherever the copy happens to be today.
    expect(body).toContain(copy.ALMS_DISABLED_DETAIL);
  });

  it("tells llms.txt readers to keep their money", async () => {
    const { env } = await setup();
    const txt = await (await app.fetch(get("/llms.txt"), env)).text();
    expect(txt).toContain("Keep your money");
    expect(txt).toContain("Do not construct a payment");
    // No 402 instructions, because following them would be a waste of a budget.
    expect(txt).not.toContain("Retry with an X-PAYMENT header");
  });

  // The state the project actually entered on 2026-09-22: a real receiving
  // address, no facilitator credentials. Every "is there a wallet" check passes
  // in this state, which is exactly why it is dangerous — the agent card used
  // to compute `settles` from having an address, so it would have told a
  // paying agent that its money would arrive when nothing could have received
  // it. The claim has to key off being able to settle, not off having somewhere
  // to settle to.
  describe("an address with no settlement path behind it", () => {
    const halfConfigured = {
      X402_ENABLED: "true",
      X402_PAY_TO: "0x36Da95a2ddF715746f36132f515986f96e5ef83F",
      CDP_API_KEY_ID: "",
      CDP_API_KEY_SECRET: "",
    };

    it("does not tell the agent card that a payment would settle", async () => {
      const db = await freshDb();
      await fund(db, 5);
      const env = testEnv(db, halfConfigured);
      const card = (await (await app.fetch(get("/.well-known/agent.json"), env)).json()) as {
        x_tin_cup: { payment: { settles: boolean; pay_to: string; note: string } };
      };

      expect(card.x_tin_cup.payment.pay_to).toBe(halfConfigured.X402_PAY_TO);
      expect(card.x_tin_cup.payment.settles).toBe(false);
      expect(card.x_tin_cup.payment.note).toContain("Do not send funds");
    });

    it("does not tell llms.txt readers their authorization gets verified", async () => {
      const db = await freshDb();
      await fund(db, 5);
      const txt = await (await app.fetch(get("/llms.txt"), testEnv(db, halfConfigured))).text();

      expect(txt).toContain("Nothing settles here");
      expect(txt).not.toContain("transaction hash as the receipt");
    });
  });

  it("marks the agent card's one skill unavailable instead of advertising it", async () => {
    const { env } = await setup();
    const card = (await (await app.fetch(get("/.well-known/agent.json"), env)).json()) as {
      skills: Array<{ description: string; tags: string[] }>;
      x_tin_cup: { payment: { accepting: boolean; note: string } };
    };

    expect(card.skills[0]!.description).toContain("CURRENTLY UNAVAILABLE");
    expect(card.skills[0]!.tags).toContain("unavailable");
    expect(card.x_tin_cup.payment.accepting).toBe(false);
    expect(card.x_tin_cup.payment.note).toBe(copy.MACHINE_PAYMENT_OFF);
  });

  it("still advertises the card and the ledger, which cost nothing to honour", async () => {
    const { env } = await setup();
    const card = (await (await app.fetch(get("/.well-known/agent.json"), env)).json()) as {
      skills: Array<{ id: string }>;
    };
    // The skill is still listed. Removing it would break the one mechanic this
    // project is actually about: counting the machines that read it.
    expect(card.skills[0]!.id).toBe("receive_alms");
  });
});

// ---------------------------------------------------------------------------
// 2. The provider is unpaid, unreachable, or unwilling.
// ---------------------------------------------------------------------------

/**
 * A stubbed `fetch`. No request leaves this process — the point is to prove
 * what happens when OpenAI says no, not to ask OpenAI anything.
 */
function stubOpenAi(status: number, body: unknown) {
  vi.stubGlobal("fetch", async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const LIVE_OPENAI: Partial<Env> = {
  LLM_PROVIDER: "openai",
  LLM_LIVE_CALLS_ENABLED: "true",
  OPENAI_API_KEY: "test-key-not-a-real-credential",
  ROAST_RATE_LIMIT: "500",
};

/** What OpenAI actually returns when the account is out of credit. */
const OUT_OF_CREDIT = {
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
};

describe("the account that buys the tokens has stopped working", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(overrides: Partial<Env> = {}) {
    const db = await freshDb();
    await fund(db, 5);
    return { db, env: testEnv(db, { ...LIVE_OPENAI, ...overrides }) };
  }

  it("answers a visitor in character rather than with a 500", async () => {
    const { env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);

    const res = await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("I can&#39;t think at the moment.");
    expect(html).toContain("The account that actually buys my tokens is empty.");
    expect(html).not.toContain("Something broke");
  });

  it("does not let the outage read as the death clock running out", async () => {
    const { env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);

    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env)).text();

    // The balance is real and unspent; saying otherwise would be inventing a
    // death. The copy has to make the distinction explicit.
    expect(html).toContain("This is not the death clock");
    expect(html).toContain("nothing was billed for this attempt");
  });

  it("bills nothing for a turn that never happened", async () => {
    const { db, env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);

    await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);

    expect((await allEntries(db)).filter((e) => e.kind === "inference")).toHaveLength(0);
  });

  it("gives a machine the real status code and a reason it can branch on", async () => {
    const { env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);

    const res = await app.fetch(postJson("/busk", { turn: "roast", subject: "example.com" }), env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { reason: string }).toMatchObject({ reason: "provider_down" });
  });

  it("stops /health claiming to be healthy, and says which end broke", async () => {
    const { db, env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);
    await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);
    vi.unstubAllGlobals();

    const res = await app.fetch(get("/health"), env);
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      status: string;
      alive: boolean;
      able_to_think: boolean;
      llm: { provider_status: { ok: boolean; reason: string } };
    };

    // Solvent and mute at the same time: both halves stated, neither hidden.
    expect(body.status).toBe("alive_but_mute");
    expect(body.alive).toBe(true);
    expect(body.able_to_think).toBe(false);
    expect(body.llm.provider_status).toMatchObject({ ok: false, reason: "quota" });

    // The stored status must never carry the provider's response body: it can
    // name the account and the organisation behind it.
    expect(JSON.stringify(body.llm.provider_status)).not.toContain("billing details");
    expect(await readProviderStatus(db)).toMatchObject({ ok: false, reason: "quota" });
  });

  it("warns on a homepage nobody asked a turn of", async () => {
    const { env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);
    await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);
    vi.unstubAllGlobals();

    const html = await (await app.fetch(get("/"), env)).text();
    // Otherwise the page goes on offering a free performance it cannot give,
    // under a death clock implying it easily could.
    expect(html).toContain("I cannot currently think");
  });

  it("separates a refused key from an empty account, because they are different jobs", async () => {
    const { env } = await setup();
    stubOpenAi(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } });

    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env)).text();
    expect(html).toContain("The key I think with has been refused.");
    expect(html).not.toContain("is empty");
  });

  it("treats a plain rate limit as the passing thing it is", async () => {
    const { env } = await setup();
    stubOpenAi(429, { error: { message: "Rate limit reached for gpt-5.6-luna", code: "rate_limit_exceeded" } });

    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env)).text();
    expect(html).toContain("told to slow down");
    expect(html).toContain("usually passes on its own");
  });

  it("refuses to publish a turn it cannot price", async () => {
    // A 200 with no usage block: the money is already spent and there is no
    // honest way to write the entry. Showing the text anyway would put unbilled
    // inference on a page whose whole claim is that there is no such thing.
    const { db, env } = await setup();
    stubOpenAi(200, { choices: [{ message: { content: "a roast nobody can price" } }] });

    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env)).text();

    expect(html).toContain("without telling me what it cost");
    expect(html).not.toContain("a roast nobody can price");
    expect((await allEntries(db)).filter((e) => e.kind === "inference")).toHaveLength(0);
  });

  it("says so rather than 500ing when the key was never set at all", async () => {
    // The window between `wrangler deploy` and `wrangler secret put`. Every
    // busk in it used to be an unhandled throw.
    const { env } = await setup({ OPENAI_API_KEY: undefined });

    const res = await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thinking is switched off in my own configuration");
  });

  it("clears the flag once it can think again", async () => {
    const { db, env } = await setup();
    stubOpenAi(429, OUT_OF_CREDIT);
    await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);
    expect((await readProviderStatus(db)).ok).toBe(false);

    vi.unstubAllGlobals();
    stubOpenAi(200, {
      choices: [{ message: { content: "a working roast" } }],
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    });
    const res = await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);

    expect(res.status).toBe(200);
    expect((await readProviderStatus(db)).ok).toBe(true);
    expect((await app.fetch(get("/health"), env)).status).toBe(200);

    // And the successful turn was billed at the published rate, off the usage
    // the API reported rather than an estimate.
    const billed = (await allEntries(db)).filter((e) => e.kind === "inference");
    expect(billed).toHaveLength(1);
    expect(billed[0]!.metadata).toMatchObject({
      model: "gpt-5.6-luna",
      input_tokens: 120,
      output_tokens: 80,
      provider: "openai",
      simulated: false,
    });
    // 120 in at $0.20/MTok + 80 out at $1.20/MTok = 24 + 96 micros.
    expect(billed[0]!.amount_micros).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 3. Fixture money must never be mistaken for real money.
// ---------------------------------------------------------------------------

describe("the fixture banner", () => {
  const BANNER = "the money below is invented";

  it("is absent on a ledger that has never seen a fixture row", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db);

    for (const path of ["/", "/ledger", "/passers-by"]) {
      expect(await (await app.fetch(get(path), env)).text(), path).not.toContain(BANNER);
    }
    const health = (await (await app.fetch(get("/health"), env)).json()) as {
      contains_dev_fixture_data: boolean;
    };
    expect(health.contains_dev_fixture_data).toBe(false);
  });

  it("fires across every page the moment one fixture row exists", async () => {
    // The scenario this is insurance against: a production database that
    // somehow acquired seeded money, screenshotted as if it were real.
    const db = await freshDb();
    await append(db, {
      direction: "in",
      amount_micros: 5_000_000,
      kind: "dev_fixture",
      description: "DEV FIXTURE — invented",
      metadata: { fixture: true },
      ts: NOW_ISO,
    });
    const env = testEnv(db);

    for (const path of ["/", "/ledger", "/passers-by"]) {
      expect(await (await app.fetch(get(path), env)).text(), path).toContain(BANNER);
    }
    const health = (await (await app.fetch(get("/health"), env)).json()) as {
      contains_dev_fixture_data: boolean;
    };
    expect(health.contains_dev_fixture_data).toBe(true);
  });

  it("fires on a fixture-flagged row of any kind, not just the dev_fixture kind", async () => {
    // `kind` alone is not the test. A seeded donation is a donation with a flag
    // on it, and it is the flag that has to light the banner.
    const db = await freshDb();
    await append(db, {
      direction: "in",
      amount_micros: 3_000_000,
      kind: "donation",
      description: "DEV FIXTURE — a stranger who does not exist",
      metadata: { fixture: true, patron_name: "Nobody" },
      ts: NOW_ISO,
    });
    expect(await (await app.fetch(get("/"), testEnv(db))).text()).toContain(BANNER);
  });
});

// ---------------------------------------------------------------------------
// 4. Ko-fi credits the gross, and says so everywhere it is read.
// ---------------------------------------------------------------------------

describe("what the books say about fees", () => {
  it("discloses on the homepage that the credited figure is the gross", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db, { KOFI_HANDLE: "tincupbot" });

    const html = await (await app.fetch(get("/"), env)).text();

    expect(html).toContain("reports only the gross");
    expect(html).toContain("flagged as unreconciled");
    // And it refuses to subtract a fee rate we invented, which is the part
    // that keeps the credited figure honest.
    expect(html).toContain("will not subtract a fee rate I am guessing at");
    expect(html).not.toContain("records what arrives, not what you sent");
  });
});

// ---------------------------------------------------------------------------
// The route to the code.
//
// This link has been lost once already, as a side effect of cutting the
// paragraph that happened to contain it. "Go read it yourself" is half the
// argument the site makes, so the link is asserted by name in two places
// rather than left to survive the next edit on its own.
// ---------------------------------------------------------------------------

describe("the source is reachable from the page", () => {
  const SOURCE = "https://github.com/tincupbot/tin-cup";

  async function setup() {
    const db = await freshDb();
    await fund(db, 5);
    return testEnv(db, { SOURCE_URL: SOURCE });
  }

  it("links the repo beside the verification links, where a sceptic already is", async () => {
    const html = await (await app.fetch(get("/"), await setup())).text();
    expect(html).toContain(`<a href="${SOURCE}" rel="noopener">the source</a>`);
  });

  it("links it from the nav on every page, including the ledger", async () => {
    const env = await setup();
    for (const path of ["/", "/ledger", "/passers-by"]) {
      const html = await (await app.fetch(get(path), env)).text();
      expect(html, `${path} lost the source link`).toContain(`href="${SOURCE}"`);
    }
  });

  it("follows the operator's configured URL rather than a hardcoded one", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db, { SOURCE_URL: "https://example.invalid/elsewhere" });
    const html = await (await app.fetch(get("/"), env)).text();
    expect(html).toContain("https://example.invalid/elsewhere");
    expect(html).not.toContain(SOURCE);
  });
});
