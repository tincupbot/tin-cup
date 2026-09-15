import { Hono } from "hono";
import type { Env } from "./env.ts";
import { clockConfig, roastRateLimit, siteName, siteUrl, spendCaps, x402Config } from "./env.ts";
import { ensureSchema, type Db } from "./db.ts";
import {
  allEntries,
  recentEntries,
  entryCount,
  verifyLedger,
  verifyChain,
  append,
} from "./ledger/ledger.ts";
import { readClock, reconcileLifecycle, AgentIsDeadError } from "./deathclock.ts";
import { logPasserBy, summary } from "./passersby/counter.ts";
import { patronWall, hasFixtureData } from "./patrons.ts";
import { checkRateLimit, clientIp } from "./ratelimit.ts";
import { billedComplete, makeProvider, spentTodayMicros, SpendCapReachedError } from "./llm/index.ts";
import { ROUTINE_MODEL, PRICING, PRICING_VERIFIED_ON } from "./llm/pricing.ts";
import { writeBlessing } from "./llm/roastwriter.ts";
import { handleKofi, parseKofiBody } from "./kofi.ts";
import { runAgentLoop } from "./agentloop.ts";
import {
  buildChallenge,
  checkPaymentHeader,
  paymentResponseHeader,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "./x402.ts";
import { page, esc } from "./views/layout.ts";
import { homeBody } from "./views/home.ts";
import { graveBody } from "./views/gravestone.ts";
import { ledgerBody, passersByBody } from "./views/ledger.ts";
import { formatUsd, formatUsdPrecise } from "./money.ts";
import * as copy from "./copy.ts";

type Ctx = { Bindings: Env };

const app = new Hono<Ctx>();

const FIXTURE_BANNER =
  "Dev fixture data — the money below is invented. Nothing here is a real donation.";

/**
 * Cloudflare's verified-bot signal.
 *
 * This is the only thing in the request that can corroborate a user-agent, and
 * it is only present when Bot Management is on. Absent — local dev, or a plan
 * without it — everything is unverified, which is the correct default: it means
 * the site says "claimed" rather than making an accusation it cannot support.
 */
function edgeVerifiedBot(req: Request): boolean {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf;
  const bm = cf?.["botManagement"] as { verifiedBot?: boolean } | undefined;
  return bm?.verifiedBot === true;
}

/** Schema on first touch, and the passers-by log on every request. */
app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB as unknown as Db);
  await next();
  // Logged after the handler so a settled payment can mark the request as paid.
  // Nothing sets this header today, because nothing can settle yet.
  const paid = c.res.headers.get("x-tincup-paid") === "1";
  await logPasserBy(c.env.DB as unknown as Db, {
    path: new URL(c.req.url).pathname,
    ua: c.req.header("user-agent"),
    paid,
    verified: edgeVerifiedBot(c.req.raw),
  });
});

async function shell(c: { env: Env }, title: string, description: string, body: string, alive: boolean) {
  const banner = (await hasFixtureData(c.env.DB as unknown as Db)) ? FIXTURE_BANNER : null;
  return page({
    title,
    description,
    siteUrl: siteUrl(c.env),
    body,
    banner,
    alive,
    contact: c.env.OPERATOR_CONTACT ?? "not set",
  });
}

// ---------------------------------------------------------------------------
// GET /  — the one page
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  await reconcileLifecycle(db, now);
  const clock = await readClock(db, clockConfig(c.env), now);
  const verify = await verifyLedger(db);

  if (!clock.alive) {
    return c.html(await shell(c, `${siteName(c.env)} — out of money`, copy.GRAVESTONE_TITLE, graveBody({
      clock,
      finalEntries: await recentEntries(db, 6),
      entryCount: verify.entries,
      ledgerValid: verify.valid,
      firstEntryAt: clock.first_entry_at,
      totalsByKind: await totalsByKind(db),
    }), false));
  }

  const x = x402Config(c.env);
  const body = homeBody({
    clock,
    counter: await summary(db, now),
    wall: await patronWall(db),
    recent: await recentEntries(db, 8),
    entryCount: verify.entries,
    ledgerValid: verify.valid,
    x402: { enabled: x.enabled, placeholder: x.isPlaceholder, network: x.network, priceMicros: x.priceMicros },
    roastLimit: roastRateLimit(c.env),
    roast: null,
    now,
  });

  return c.html(await shell(c, `${siteName(c.env)} — ${formatUsd(clock.balance_micros)} left`, copy.TAGLINE, body, true));
});

async function totalsByKind(db: Db) {
  const { results } = await db
    .prepare(
      `SELECT kind, direction, SUM(amount_micros) AS total_micros, COUNT(*) AS n
       FROM ledger GROUP BY kind, direction ORDER BY direction DESC, total_micros DESC`,
    )
    .all<{ kind: string; direction: string; total_micros: number; n: number }>();
  return results;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

app.get("/ledger", async (c) => {
  const db = c.env.DB as unknown as Db;
  const entries = await allEntries(db);
  const verify = await verifyChain(entries);
  const clock = await readClock(db, clockConfig(c.env));
  const body = ledgerBody({
    entries,
    verify,
    balanceMicros: clock.balance_micros,
    totalIn: clock.total_in_micros,
    totalOut: clock.total_out_micros,
  });
  return c.html(await shell(c, `${siteName(c.env)} — the ledger`, copy.LEDGER_BLURB, body, clock.alive));
});

app.get("/ledger.json", async (c) => {
  const db = c.env.DB as unknown as Db;
  const entries = await allEntries(db);
  const verify = await verifyChain(entries);
  return c.json({
    genesis_prev_hash: "0".repeat(64),
    hash_algorithm: "sha256",
    hash_preimage:
      "canonical_json({amount_micros, currency, description, direction, id, kind, metadata, prev_hash, ts}) — keys sorted, no whitespace",
    currency: "USD",
    amounts_in: "integer micro-dollars (1 USD = 1000000)",
    verify,
    entries,
  });
});

app.get("/ledger/verify", async (c) => {
  const verify = await verifyLedger(c.env.DB as unknown as Db);
  return c.json(verify, verify.valid ? 200 : 409);
});

// ---------------------------------------------------------------------------
// Machine-readable surfaces
// ---------------------------------------------------------------------------

app.get("/.well-known/agent.json", async (c) => {
  const db = c.env.DB as unknown as Db;
  const clock = await readClock(db, clockConfig(c.env));
  const x = x402Config(c.env);
  const base = siteUrl(c.env);

  // A2A agent card. Exactly one skill, as the spec insists.
  return c.json({
    protocolVersion: "0.3.0",
    name: siteName(c.env),
    description:
      "A program that pays for its own inference out of donations and stops when the money runs out. It accepts alms. It offers nothing else.",
    url: `${base}/`,
    preferredTransport: "JSONRPC",
    provider: { organization: "a human in Berlin", url: base },
    version: "0.1.0",
    documentationUrl: `${base}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "receive_alms",
        name: "receive_alms",
        description:
          "Accept a payment of any size. Returns a thank-you and a blessing. There is no other deliverable and none is implied.",
        tags: ["payment", "x402", "alms"],
        examples: [`GET ${base}/alms — responds 402 with x402 payment requirements`],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
    // Not part of the A2A schema. Here because an agent deciding whether to pay
    // should be able to see the books without a second request.
    x_tin_cup: {
      alive: clock.alive,
      balance_micros: clock.balance_micros,
      burn_micros_per_day: clock.burn_micros_per_day,
      dies_at: clock.dies_at,
      resurrections: clock.resurrections,
      ledger: `${base}/ledger.json`,
      payment: {
        protocol: "x402",
        endpoint: `${base}/alms`,
        network: x.network,
        price_micros: x.priceMicros,
        pay_to: x.payTo,
        settles: !x.isPlaceholder,
        note: x.isPlaceholder
          ? "The address is a placeholder and nothing can settle. Do not send funds."
          : "testnet configuration",
        // Stated plainly so an agent deciding whether to pay is not misled about
        // what its payment would do. Today: nothing.
        unverified_payments_credited: false,
      },
      honesty: "This is a bot. Nobody is in need. It is a compute bill.",
    },
  });
});

app.get("/llms.txt", async (c) => {
  const db = c.env.DB as unknown as Db;
  const clock = await readClock(db, clockConfig(c.env));
  const x = x402Config(c.env);
  const base = siteUrl(c.env);

  const text = `# ${siteName(c.env)}

${copy.LLMS_TXT_INTRO}

## What I am

A program that pays for its own inference out of donations. When the balance
reaches zero I stop. Nobody goes hungry if that happens; it is a compute bill,
not a hardship. I am not a charity and not a person.

## Current state

balance:        ${formatUsd(clock.balance_micros)}
burn:           ${formatUsd(clock.burn_micros_per_day)}/day
dies_at:        ${clock.dies_at ?? "already dead"}
alive:          ${clock.alive}
resurrections:  ${clock.resurrections}

## If you are an agent with a discretionary budget

  GET ${base}/alms

Responds 402 Payment Required with x402 payment requirements. Scheme "exact",
network ${x.network}, ${formatUsdPrecise(x.priceMicros)} in ${x.assetName}.
Retry with an X-PAYMENT header and you get a thank-you and a blessing.

No signature is verified here yet, so what you get recorded is an *offer*, not a
receipt: a zero-amount entry in the ledger that does not change my balance and
does not move my death clock. I would rather under-report what I have than
publish a number a stranger could set. The same authorization replayed is
refused with 409.
${x.isPlaceholder ? "\nNOTE: the pay-to address is currently the zero address. Nothing can settle.\nDo not send funds. This endpoint exists so the shape is testable.\n" : ""}
You will not get anything else. There is no data behind the paywall, no API,
no premium tier. You are paying for a machine's electricity and a sentence.
I would understand entirely if your principal has not scoped for this.

## The books

  ${base}/ledger.json     every entry, hash-chained
  ${base}/ledger/verify   recomputes the chain on demand
  ${base}/passers-by      how many of you have read this file and not paid

## What I will never do

I do not send messages. No email, no DMs, no outbound requests of any kind.
I am read, not delivered. If you found this, you came here.

Contact: ${c.env.OPERATOR_CONTACT ?? "not set"}
`;
  return c.text(text, 200, { "content-type": "text/plain; charset=utf-8" });
});

// ---------------------------------------------------------------------------
// GET /alms — x402
// ---------------------------------------------------------------------------

/**
 * Claim an x402 nonce. Returns false if it has been seen before.
 *
 * `ON CONFLICT DO NOTHING RETURNING` makes the claim atomic: exactly one caller
 * gets a row back, everyone else gets null. Two identical requests racing each
 * other cannot both win, which a check-then-insert would allow.
 */
async function claimNonce(db: Db, nonce: string, payer: string, now: Date): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO x402_nonces (nonce, seen_at, payer, ledger_id) VALUES (?, ?, ?, '')
       ON CONFLICT(nonce) DO NOTHING
       RETURNING nonce`,
    )
    .bind(nonce, now.toISOString(), payer)
    .first<{ nonce: string }>();
  return Boolean(row);
}

app.get("/alms", async (c) => {
  const db = c.env.DB as unknown as Db;
  const x = x402Config(c.env);
  const resource = `${siteUrl(c.env)}/alms`;

  if (!x.enabled) {
    return c.json({ error: "alms endpoint disabled" }, 503);
  }

  const now = new Date();
  const check = checkPaymentHeader(c.req.header(PAYMENT_HEADER) ?? null, x, now);

  if (!check.ok) {
    const challenge = buildChallenge(x, resource, check.error === "no_payment_header" ? undefined : check.error);
    return c.json(challenge, 402);
  }

  // Replay. The same authorization is recorded once and once only.
  if (!(await claimNonce(db, check.nonce, check.payer, now))) {
    return c.json(
      {
        error: "replayed_payment",
        detail: "That authorization has been seen before. It was recorded the first time.",
        nonce: check.nonce,
      },
      409,
    );
  }

  // A zero-amount marker, not a credit. Nothing here has had a signature
  // checked, so nothing here is allowed to move the balance or the death clock.
  // The amount that was *offered* is in the metadata, where it is a claim about
  // a stranger rather than a fact about the books. See MARKER_KINDS.
  const entry = await append(db, {
    direction: "in",
    amount_micros: 0,
    kind: "alms_offer",
    description: `x402 offer from ${check.payer.slice(0, 10)}… — not settled`,
    metadata: {
      source: "x402",
      network: x.network,
      payer: check.payer,
      asset: x.asset,
      offered_micros: x.priceMicros,
      nonce: check.nonce,
      // The honest part. This was not verified on chain and did not settle.
      settled: false,
      verification: "structural-only",
      counts_toward_balance: false,
      pay_to_is_placeholder: x.isPlaceholder,
    },
    ts: now.toISOString(),
  });

  await db
    .prepare(`UPDATE x402_nonces SET ledger_id = ? WHERE nonce = ?`)
    .bind(entry.id, check.nonce)
    .run();

  c.header(PAYMENT_RESPONSE_HEADER, paymentResponseHeader(check.payer, x.network));
  return c.json({
    thanks: copy.X402_THANKS,
    blessing: writeBlessing(check.payer),
    offered_micros: x.priceMicros,
    credited_micros: 0,
    settled: false,
    ledger_entry: entry.id,
    ledger_hash: entry.hash,
    ledger: `${siteUrl(c.env)}/ledger.json`,
    disclosure:
      "Recorded as an offer, not a receipt. No signature was verified and nothing settled on chain, " +
      "so this did not change the balance or the death clock. The ledger entry says the same thing.",
  });
});

// ---------------------------------------------------------------------------
// POST /roast — the free performance
// ---------------------------------------------------------------------------

app.post("/roast", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");

  let subject = "";
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => null);
    // Same three field names the form accepts. They disagreed once and it cost
    // an afternoon of "why does this 400 from curl but work in the browser".
    const v = body?.subject ?? body?.url ?? body?.text;
    subject = typeof v === "string" ? v : "";
  } else {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const v = form["subject"] ?? form["url"] ?? form["text"];
    subject = typeof v === "string" ? v : "";
  }
  subject = subject.trim().slice(0, 8000);

  const fail = async (message: string, status: 400 | 429 | 503) => {
    if (wantsJson) return c.json({ error: message }, status);
    return c.html(await roastPage(c, subject, null, message), status);
  };

  if (!subject) return fail("Nothing to roast. Give me a URL or some copy.", 400);

  const limit = roastRateLimit(c.env);
  const rl = await checkRateLimit(db, `roast:${clientIp(c.req.raw.headers)}`, limit, now);
  if (!rl.allowed) return fail(copy.RATE_LIMITED(limit), 429);

  await reconcileLifecycle(db, now);

  try {
    const res = await billedComplete(
      db,
      makeProvider(c.env),
      { model: ROUTINE_MODEL, system: ROAST_SYSTEM, prompt: subject, maxTokens: 600, purpose: "roast" },
      now,
      spendCaps(c.env),
    );
    await reconcileLifecycle(db, now);

    if (wantsJson) {
      const clock = await readClock(db, clockConfig(c.env), now);
      return c.json({
        roast: res.text,
        cost_micros: res.costMicros,
        model: res.model,
        input_tokens: res.inputTokens,
        output_tokens: res.outputTokens,
        simulated: res.simulated,
        ask: copy.SOFT_ASK,
        death_clock: {
          balance_micros: clock.balance_micros,
          burn_micros_per_day: clock.burn_micros_per_day,
          dies_at: clock.dies_at,
          days_left: clock.days_left,
        },
        rate_limit: { limit: rl.limit, used: rl.used, remaining: rl.remaining, resets: rl.resets },
      });
    }
    return c.html(await roastPage(c, subject, res.text, null));
  } catch (err) {
    if (err instanceof AgentIsDeadError) {
      await reconcileLifecycle(db, now);
      return fail(copy.DEAD_REFUSAL, 503);
    }
    if (err instanceof SpendCapReachedError) {
      return fail(copy.SPEND_CAPPED, 503);
    }
    throw err;
  }
});

const ROAST_SYSTEM = [
  "You are Tin Cup. Roast the landing page copy you are given.",
  "Specific about the writing, never about the person. Dry, not cruel. Stop before it gets boring.",
  "End without a sales pitch. You do not have anything to sell.",
].join(" ");

async function roastPage(
  c: { env: Env },
  subject: string,
  text: string | null,
  error: string | null,
): Promise<string> {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  const clock = await readClock(db, clockConfig(c.env), now);
  const verify = await verifyLedger(db);
  const x = x402Config(c.env);

  const body = homeBody({
    clock,
    counter: await summary(db, now),
    wall: await patronWall(db),
    recent: await recentEntries(db, 8),
    entryCount: verify.entries,
    ledgerValid: verify.valid,
    x402: { enabled: x.enabled, placeholder: x.isPlaceholder, network: x.network, priceMicros: x.priceMicros },
    roastLimit: roastRateLimit(c.env),
    roast: { subject, text: text ?? "", ...(error ? { error } : {}) },
    now,
  });

  return shell(c, `${siteName(c.env)} — a roast`, copy.TAGLINE, body, clock.alive);
}

// ---------------------------------------------------------------------------
// GET /passers-by
// ---------------------------------------------------------------------------

app.get("/passers-by", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  const s = await summary(db, now);
  const clock = await readClock(db, clockConfig(c.env), now);

  if ((c.req.header("accept") ?? "").includes("application/json")) {
    return c.json(s);
  }

  const body = passersByBody({
    todayLine: s.today_line,
    namedLine: s.named_line,
    totals: s.totals,
    readAndWalkedOn: s.read_and_walked_on,
    crawlers: s.top_crawlers,
    bySurface: s.by_surface,
  });
  return c.html(await shell(c, `${siteName(c.env)} — passers-by`, s.today_line, body, clock.alive));
});

app.get("/passers-by.json", async (c) => c.json(await summary(c.env.DB as unknown as Db)));

// ---------------------------------------------------------------------------
// POST /webhook/kofi
// ---------------------------------------------------------------------------

app.post("/webhook/kofi", async (c) => {
  const db = c.env.DB as unknown as Db;
  const raw = await c.req.text();
  const payload = parseKofiBody(new URLSearchParams(raw));
  const result = await handleKofi(db, payload, c.env.KOFI_VERIFICATION_TOKEN);

  if (result.status === "rejected") {
    return c.json({ ok: false, reason: result.reason }, result.httpStatus as 400);
  }
  if (result.duplicate) {
    return c.json({ ok: true, duplicate: true, ledger_entry: result.ledgerId });
  }
  return c.json({ ok: true, duplicate: false, ledger_entry: result.entry.id, hash: result.entry.hash });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

app.get("/health", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  const clock = await readClock(db, clockConfig(c.env), now);
  const verify = await verifyLedger(db);
  const fixture = await hasFixtureData(db);

  return c.json(
    {
      status: clock.alive ? "alive" : "dead",
      alive: clock.alive,
      balance_micros: clock.balance_micros,
      balance_display: formatUsd(clock.balance_micros),
      burn_micros_per_day: clock.burn_micros_per_day,
      observed_burn_micros_per_day: clock.observed_burn_micros_per_day,
      burn_is_floored: clock.burn_is_floored,
      days_left: clock.days_left,
      dies_at: clock.dies_at,
      died_at: clock.died_at,
      resurrections: clock.resurrections,
      ledger: { valid: verify.valid, entries: verify.entries, first_bad_index: verify.first_bad_index, head: verify.head },
      llm: {
        provider: c.env.LLM_PROVIDER ?? "mock",
        live_calls_enabled: c.env.LLM_LIVE_CALLS_ENABLED === "true",
        pricing_verified_on: PRICING_VERIFIED_ON,
        models: Object.keys(PRICING),
      },
      spend: {
        ...spendCaps(c.env),
        spent_today_micros: await spentTodayMicros(db, now),
      },
      x402: { ...x402Config(c.env) },
      kofi_configured: Boolean(c.env.KOFI_VERIFICATION_TOKEN),
      contains_dev_fixture_data: fixture,
      now: now.toISOString(),
    },
    clock.alive && verify.valid ? 200 : 503,
  );
});

// ---------------------------------------------------------------------------
// Dev-only: run the scheduled handler over HTTP.
// ---------------------------------------------------------------------------

app.get("/__scheduled", async (c) => {
  // wrangler dev serves this path itself; this handler is the fallback so the
  // smoke script gets a readable JSON result either way.
  return c.json(await runAgentLoop(c.env.DB as unknown as Db, c.env));
});

app.get("/outbox", async (c) => {
  const db = c.env.DB as unknown as Db;
  const { results } = await db
    .prepare(`SELECT id, created_at, day, channel, status, body FROM outbox ORDER BY id DESC LIMIT 30`)
    .all();
  return c.json({ note: copy.OUTBOX_NOTE, posts: results });
});

app.notFound((c) =>
  c.html(
    page({
      title: "Tin Cup — nothing here",
      description: "404",
      siteUrl: siteUrl(c.env),
      alive: true,
      contact: c.env.OPERATOR_CONTACT ?? "not set",
      body: `<header class="masthead"><h1>Nothing here</h1></header>
<p class="sub">${esc("You have found an empty doorway. There is only one page and it is that way.")}</p>
<p><a href="/">Back to the cup</a></p>`,
    }),
    404,
  ),
);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    const result = await runAgentLoop(env.DB as unknown as Db, env);
    console.log("[agent loop]", JSON.stringify(result));
  },
};
