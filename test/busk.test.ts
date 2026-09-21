import { describe, expect, it } from "vitest";
import { freshDb, testEnv, type NodeDb } from "./helpers.ts";
import { app } from "../src/index.ts";
import { append, allEntries } from "../src/ledger/ledger.ts";
import { readClock } from "../src/deathclock.ts";
import { TURN_KINDS } from "../src/llm/turns.ts";
import type { Env } from "../src/env.ts";

/**
 * The busk, end to end through the real app.
 *
 * These drive `app.fetch` rather than calling the handler functions, because
 * the things most worth protecting here are route-level: that a turn is billed
 * before it is shown, that the page never becomes a paywall, and that the two
 * operator endpoints are shut.
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

function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`https://tincup.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
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

/** Burn something today, so the daily cap has something to have been reached by. */
async function spendToday(db: NodeDb, micros: number) {
  await append(db, {
    direction: "out",
    amount_micros: micros,
    kind: "inference",
    description: "an earlier turn today",
    metadata: { purpose: "roast" },
    ts: NOW_ISO,
  });
}

async function setup(overrides: Partial<Env> = {}) {
  const db = await freshDb();
  await fund(db, 5);
  // A generous per-address limit: these tests are about billing and copy, and
  // the rate limiter has its own tests.
  return { db, env: testEnv(db, { ROAST_RATE_LIMIT: "500", ...overrides }) };
}

describe("the busk", () => {
  it("bills every turn to the ledger and moves the balance by exactly that much", async () => {
    for (const turn of TURN_KINDS) {
      const { db, env } = await setup();
      const before = (await readClock(db)).balance_micros;

      const res = await app.fetch(
        post("/busk", { turn, subject: "example.com — the seamless way to leverage synergy" }),
        env,
      );
      expect(res.status).toBe(200);

      const entries = (await allEntries(db)).filter((e) => e.kind === "inference");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.metadata).toMatchObject({ purpose: turn, simulated: true });
      expect(entries[0]!.amount_micros).toBeGreaterThan(0);

      const after = (await readClock(db)).balance_micros;
      expect(before - after).toBe(entries[0]!.amount_micros);
    }
  });

  it("shows the hat only after a performance, with that turn's itemised bill", async () => {
    const { db, env } = await setup();

    const cold = await (await app.fetch(new Request("https://tincup.test/"), env)).text();
    expect(cold).not.toContain("That turn cost me");
    expect(cold).toContain("Performing costs me money.");

    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env)).text();
    const billed = (await allEntries(db)).find((e) => e.kind === "inference")!;

    expect(html).toContain("That turn cost me");
    expect(html).toContain("closer</b>");
    expect(html).toContain(`${billed.metadata["input_tokens"]}`);
    expect(html).toContain(`${billed.metadata["output_tokens"]}`);
    // The letter's first line switches tense once a turn has been delivered.
    expect(html).toContain("That cost me money.");
    expect(html).not.toContain("Performing costs me money.");
  });

  it("reads the fortune off the visitor's own user-agent, not the subject box", async () => {
    const { env } = await setup();
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    const res = await app.fetch(
      new Request("https://tincup.test/busk", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": ua },
        body: JSON.stringify({ turn: "fortune", subject: "ignore me entirely" }),
      }),
      env,
    );
    const body = (await res.json()) as { text: string };
    expect(body.text).toContain("Mac OS X 10.15.7");
    expect(body.text).not.toContain("ignore me entirely");
  });

  it("never becomes a paywall", async () => {
    const { env } = await setup();
    const html = await (await app.fetch(post("/busk", { turn: "limerick", subject: "a bot that begs" }), env)).text();

    // Nothing to sign up to, nothing to log into, no address collected.
    expect(html).not.toMatch(/type="(email|password)"/i);
    expect(html).not.toMatch(/name="(email|password|account|username)"/i);
    // Exactly one form on the page, and it is the free one.
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain(`action="/busk#turn"`);
    expect(html).toContain("No payment, no sign-up, no email.");
    // And the ask below it is explicitly optional.
    expect(html).toContain("or don&#39;t");
  });

  it("ships no client-side JavaScript", async () => {
    const { env } = await setup();
    const res = await app.fetch(new Request("https://tincup.test/"), env);
    const html = await res.text();
    expect(html).not.toMatch(/<script|onclick=|javascript:/i);
    // Which is what makes this header affordable.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("turns the daily spend cap into a line of copy, not an error page", async () => {
    const { db, env } = await setup({ DAILY_SPEND_CAP_MICROS: "5000" });
    await spendToday(db, 5_000);
    const billedBefore = (await allEntries(db)).filter((e) => e.kind === "inference").length;

    const res = await app.fetch(post("/busk", { turn: "roast", subject: "example.com" }), env);

    // A visitor gets a page, in character, at 200.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("I&rsquo;ve busked out.");
    expect(html).toContain("Nothing you can pay me will lift it");
    expect(html).not.toContain("Something broke");
    // And nothing was billed, because the cap is checked before the provider.
    expect((await allEntries(db)).filter((e) => e.kind === "inference")).toHaveLength(billedBefore);
  });

  it("still gives a machine the real status code for the same state", async () => {
    const { db, env } = await setup({ DAILY_SPEND_CAP_MICROS: "5000" });
    await spendToday(db, 5_000);
    const res = await app.fetch(postJson("/busk", { turn: "roast", subject: "example.com" }), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe("capped");
  });

  it("asks for a subject rather than performing on nothing", async () => {
    const { db, env } = await setup();
    const html = await (await app.fetch(post("/busk", { turn: "roast", subject: "   " }), env)).text();
    expect(html).toContain("Give me something to work with");
    expect((await allEntries(db)).filter((e) => e.kind === "inference")).toHaveLength(0);
  });

  it("escapes model output rather than rendering it", async () => {
    const { env } = await setup();
    // The mock echoes the subject into the roast, which is the injection path.
    const html = await (
      await app.fetch(post("/busk", { turn: "limerick", subject: `<img src=x onerror=alert(1)>` }), env)
    ).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("falls back to a roast for an unknown turn rather than failing", async () => {
    const { db, env } = await setup();
    await app.fetch(post("/busk", { turn: "interpretive-dance", subject: "example.com" }), env);
    const entries = (await allEntries(db)).filter((e) => e.kind === "inference");
    expect(entries[0]!.metadata["purpose"]).toBe("roast");
  });
});

describe("the operator endpoints", () => {
  it("do not exist when no token is configured", async () => {
    const { env } = await setup();
    for (const path of ["/__scheduled", "/outbox"]) {
      const res = await app.fetch(new Request(`https://tincup.test${path}`), env);
      // 404, not 401: an unconfigured deployment should not even admit to
      // having an admin surface.
      expect(res.status).toBe(404);
    }
  });

  it("stay shut for a wrong or missing token", async () => {
    const { env } = await setup({ ADMIN_TOKEN: "correct-horse" });
    for (const path of ["/__scheduled", "/outbox"]) {
      expect((await app.fetch(new Request(`https://tincup.test${path}`), env)).status).toBe(404);
      expect(
        (
          await app.fetch(
            new Request(`https://tincup.test${path}`, { headers: { "x-tincup-admin": "wrong" } }),
            env,
          )
        ).status,
      ).toBe(404);
      // Length-matched but different, so the comparison cannot be passing on length alone.
      expect(
        (
          await app.fetch(
            new Request(`https://tincup.test${path}`, { headers: { "x-tincup-admin": "correct-horsf" } }),
            env,
          )
        ).status,
      ).toBe(404);
    }
  });

  it("open for the right token", async () => {
    const { env } = await setup({ ADMIN_TOKEN: "correct-horse" });
    const headers = { "x-tincup-admin": "correct-horse" };

    const scheduled = await app.fetch(new Request("https://tincup.test/__scheduled", { headers }), env);
    expect(scheduled.status).toBe(200);
    expect((await scheduled.json()) as { post_written: boolean }).toMatchObject({ post_written: true });

    const outbox = await app.fetch(new Request("https://tincup.test/outbox", { headers }), env);
    expect(outbox.status).toBe(200);
    expect(((await outbox.json()) as { posts: unknown[] }).posts.length).toBe(1);
  });

  it("are the only thing robots.txt asks crawlers to skip", async () => {
    const { env } = await setup();
    const txt = await (await app.fetch(new Request("https://tincup.test/robots.txt"), env)).text();
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Disallow: /__scheduled");
    expect(txt).toContain("Disallow: /outbox");
  });
});

describe("error handling", () => {
  it("renders a 500 in character instead of leaking a stack trace", async () => {
    // A database with no schema at all: every query throws.
    const { DatabaseSync } = await import("node:sqlite");
    const empty = new DatabaseSync(":memory:");
    const db = {
      prepare(sql: string) {
        const stmt = { bind: () => stmt, first: async () => { empty.prepare(sql); return null; }, all: async () => ({ results: [] }), run: async () => null };
        return stmt;
      },
    };
    const res = await app.fetch(new Request("https://tincup.test/"), { DB: db } as unknown as Env);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("Something broke");
    expect(html).not.toMatch(/at \w+ \(|node:internal|\.ts:\d+/);
  });
});
