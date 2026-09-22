import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, X402Config } from "./env.ts";
import {
  ADMIN_HEADER,
  adminToken,
  clockConfig,
  homeCacheSeconds,
  kofiDryRun,
  passersbySampleOneIn,
  roastRateLimit,
  siteName,
  siteUrl,
  kofiUrl,
  sourceUrl,
  spendCaps,
  tokenMatches,
  x402Config,
} from "./env.ts";
import { isMissingTable, SchemaMissingError, type Db } from "./db.ts";
import {
  allEntries,
  recentEntries,
  verifyLedger,
  verifyChain,
  readLedgerState,
  append,
} from "./ledger/ledger.ts";
import { readClock, reconcileLifecycle, deathShiftLabel, AgentIsDeadError } from "./deathclock.ts";
import { logPasserBy, summary } from "./passersby/counter.ts";
import { crowdToday, averageTurnMicros, busksSince } from "./crowd.ts";
import { patronWall, hasFixtureData } from "./patrons.ts";
import { checkRateLimit, clientIp } from "./ratelimit.ts";
import {
  billedComplete,
  makeProvider,
  spentTodayMicros,
  readProviderStatus,
  SpendCapReachedError,
  ProviderUnavailableError,
} from "./llm/index.ts";
import { PRICING, PRICING_VERIFIED_ON, routineModel } from "./llm/pricing.ts";
import { parseTurn, turnDef, type TurnKind } from "./llm/turns.ts";
import { writeBlessing } from "./llm/roastwriter.ts";
import { handleKofi, parseKofiBody } from "./kofi.ts";
import { lastDeliveryAt, outcomeOf, recentDeliveries, recordDelivery } from "./webhooklog.ts";
import { runAgentLoop } from "./agentloop.ts";
import {
  buildChallenge,
  buildRequirements,
  checkPaymentHeader,
  paymentResponseHeader,
  readPatronName,
  shortPayer,
  PATRON_HEADER,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
} from "./x402.ts";
import { atomicToMicros, facilitatorConfig, settlePayment, verifyPayment } from "./facilitator.ts";
import { pngResponse, PORTRAIT_PNG, ICON_PNG } from "./assets/serve.ts";
import { PORTRAIT_PATH, ICON_PATH } from "./assets/paths.ts";
import { page, esc } from "./views/layout.ts";
import { homeBody, homeBanner, type HomeData, type Performance, type BuskNotice } from "./views/home.ts";
import { graveBody } from "./views/gravestone.ts";
import { ledgerBody, passersByBody } from "./views/ledger.ts";
import { formatUsd, formatUsdPrecise } from "./money.ts";
import * as copy from "./copy.ts";

type Ctx = { Bindings: Env };

const app = new Hono<Ctx>();

const FIXTURE_BANNER =
  "Dev fixture data — the money below is invented. Nothing here is a real donation.";

/**
 * Security headers, on everything.
 *
 * The CSP is the cheap one and the important one. This site ships zero bytes of
 * client-side JavaScript — the busk is a form POST and the repertoire is a radio
 * group — so `default-src 'none'` costs nothing and removes the entire class of
 * injected-script bugs. The only allowances are the inline stylesheet, images
 * from this origin and from data: URLs, and `form-action 'self'` so the busk
 * still posts. No third-party origin can serve a pixel here, which keeps the
 * "no trackers" claim on the page structurally true rather than promised.
 *
 * If a future change needs a script tag, the correct response is to not need it.
 */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("content-security-policy", CSP);
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "no-referrer");
  c.res.headers.set("x-frame-options", "DENY");
  c.res.headers.set("permissions-policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
  c.res.headers.set("cross-origin-opener-policy", "same-origin");
});

/**
 * `Link:` — the ask that costs nothing to make and cannot be mistaken for a gate.
 *
 * `payment` is a registered IANA link relation meaning, in full, "indicates a
 * resource where payment is accepted". It is the one standards-blessed way to
 * say money is welcome here without touching the status code, and a machine
 * that ignores it loses nothing. It rides on every response, including the ones
 * that were free, which is the whole point: the hat goes round after the trick,
 * not at the door.
 *
 * The rule it obeys: the machine cup is advertised only when a payment sent to
 * it would actually settle and be credited. A `rel="payment"` pointing at an
 * endpoint that answers 503 is a signpost to a locked door, and this site does
 * not get to be sloppy about that in a header just because nobody reads headers.
 *
 * The Ko-fi link has no such condition — it is a real payment page whenever it
 * is configured at all.
 */
app.use("*", async (c, next) => {
  await next();
  if (IMAGE_PATHS.has(new URL(c.req.url).pathname)) return;
  const base = siteUrl(c.env);
  const x = x402Config(c.env);
  const links: string[] = [];
  if (x.enabled && x.settlementReady) links.push(`<${base}/alms>; rel="payment"`);
  const kofi = kofiUrl(c.env);
  if (kofi) links.push(`<${kofi}>; rel="payment"; type="text/html"`);
  links.push(`<${base}/.well-known/agent.json>; rel="service-desc"`);
  links.push(`<${base}/llms.txt>; rel="describedby"`);
  c.res.headers.set("link", links.join(", "));
});

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

/**
 * The passers-by log.
 *
 * Runs after the handler so a settled payment can mark the request as paid, and
 * skips 404s entirely — a misspelled URL from a crawler used to cost two
 * database writes, which is a way to be DDoSed by typos. See `logPasserBy` for
 * what is aggregated versus what is sampled.
 *
 * The write is deliberately swallowed on failure. This runs in global
 * middleware on a response the handler has already built, so an unguarded
 * throw here turns a rendered page into a 500 — the counter would be able to
 * take the whole site down with it. The counter is a nice-to-have; the page
 * and the books are not. Losing a row is the cheaper failure, and an
 * undercounted passers-by total is honest in the direction that costs us
 * nothing: it can only ever understate the crowd.
 */
app.use("*", async (c, next) => {
  await next();
  if (c.res.status === 404) return;
  // A browser fetching the portrait is not a second visitor. Counting the
  // image would report one human as two requests, on the one site whose
  // product is that its numbers can be checked.
  if (IMAGE_PATHS.has(new URL(c.req.url).pathname)) return;
  const paid = c.res.headers.get("x-tincup-paid") === "1";
  try {
    await logPasserBy(c.env.DB as unknown as Db, {
      path: new URL(c.req.url).pathname,
      ua: c.req.header("user-agent"),
      paid,
      verified: edgeVerifiedBot(c.req.raw),
      rawSampleOneIn: passersbySampleOneIn(c.env),
    });
  } catch (err) {
    console.error("passer-by log failed", err);
  }
});

// ---------------------------------------------------------------------------
// The two images. Everything else on this site is text.
// ---------------------------------------------------------------------------

const IMAGE_PATHS = new Set([PORTRAIT_PATH, ICON_PATH]);

app.get(PORTRAIT_PATH, (c) => pngResponse(PORTRAIT_PNG, c.req.raw));
app.get(ICON_PATH, (c) => pngResponse(ICON_PNG, c.req.raw));

async function shell(
  c: { env: Env },
  title: string,
  description: string,
  body: string,
  alive: boolean,
  aboveFold: string | null = null,
) {
  const banner = (await hasFixtureData(c.env.DB as unknown as Db)) ? FIXTURE_BANNER : null;
  return page({
    title,
    description,
    siteUrl: siteUrl(c.env),
    body,
    banner,
    aboveFold,
    alive,
    source: sourceUrl(c.env),
    contact: c.env.OPERATOR_CONTACT ?? "not set",
  });
}

// ---------------------------------------------------------------------------
// The homepage. A busk first, a letter second.
// ---------------------------------------------------------------------------

/**
 * Gather everything the homepage renders.
 *
 * Every read in here is either O(1) off the materialised ledger summary or
 * bounded by an index. Nothing rehashes the chain — that is what
 * `/ledger/verify` is for, and the page links to it rather than claiming its
 * result. Publishing "chain verifies" without having verified it would be
 * precisely the kind of unearned claim this project exists to not make.
 */
async function homeData(
  c: { env: Env },
  now: Date,
  opts: { turn: TurnKind; subject: string; performance?: Performance | null; notice?: BuskNotice | null },
): Promise<HomeData> {
  const db = c.env.DB as unknown as Db;
  const clock = await readClock(db, clockConfig(c.env), now);
  const state = await readLedgerState(db);
  const x = x402Config(c.env);
  const caps = spendCaps(c.env);

  const avgTurn = await averageTurnMicros(db, now);
  const spent = await spentTodayMicros(db, now);

  return {
    clock,
    crowd: await crowdToday(db, now),
    wall: await patronWall(db),
    recent: await recentEntries(db, 8),
    entryCount: state.entries,
    chainHead: state.entries ? state.head : null,
    x402: {
      enabled: x.enabled,
      placeholder: x.isPlaceholder,
      settles: x.settlementReady,
      network: x.network,
      priceMicros: x.priceMicros,
    },
    selectedTurn: opts.turn,
    subject: opts.subject,
    performance: opts.performance ?? null,
    notice: opts.notice ?? null,
    turnsLeftToday: Math.max(0, Math.floor((caps.dailyMicros - spent) / avgTurn)),
    // One indexed row read. Worth it: without it the page offers a free
    // performance it cannot currently give, under a death clock implying it
    // easily could.
    providerDown: !(await readProviderStatus(db)).ok,
    addressLimit: roastRateLimit(c.env),
    sourceUrl: sourceUrl(c.env),
    kofiUrl: kofiUrl(c.env),
    now,
  };
}

async function renderHome(
  c: { env: Env },
  now: Date,
  opts: { turn: TurnKind; subject: string; performance?: Performance | null; notice?: BuskNotice | null },
): Promise<{ html: string; alive: boolean }> {
  const db = c.env.DB as unknown as Db;
  await reconcileLifecycle(db, now);
  const data = await homeData(c, now, opts);

  if (!data.clock.alive) {
    const verify = await verifyLedger(db);
    const html = await shell(
      c,
      `${siteName(c.env)} — out of money`,
      copy.GRAVESTONE_TITLE,
      graveBody({
        clock: data.clock,
        finalEntries: await recentEntries(db, 6),
        entryCount: verify.entries,
        ledgerValid: verify.valid,
        firstEntryAt: data.clock.first_entry_at,
        totalsByKind: await totalsByKind(db),
      }),
      false,
    );
    return { html, alive: false };
  }

  const html = await shell(
    c,
    `${siteName(c.env)} — ${formatUsd(data.clock.balance_micros)} left`,
    copy.TAGLINE,
    homeBody(data),
    true,
    homeBanner(data),
  );
  return { html, alive: true };
}

app.get("/", async (c) => {
  const cacheSeconds = homeCacheSeconds(c.env);
  const cache = cacheSeconds > 0 ? edgeCache() : null;
  const cacheKey = new Request(new URL("/", c.req.url).toString(), { method: "GET" });

  if (cache) {
    const hit = await cache.match(cacheKey);
    // A hit still falls through the passers-by middleware above, so caching the
    // bytes does not cost us the count. That is the whole reason the counter
    // reads the aggregate rather than the rendered page.
    if (hit) return new Response(hit.body, hit);
  }

  const { html, alive } = await renderHome(c, new Date(), { turn: "roast", subject: "" });
  const res = c.html(html);
  if (cache && alive) {
    res.headers.set("cache-control", `public, max-age=${cacheSeconds}`);
    await cache.put(cacheKey, res.clone());
  } else {
    res.headers.set("cache-control", "no-store");
  }
  return res;
});

/** `caches.default` is absent outside the Workers runtime. Tests do not cache. */
function edgeCache(): Cache | null {
  const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

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
// POST /busk — the performance. Plain form POST, no JavaScript anywhere.
// ---------------------------------------------------------------------------

/**
 * One turn, billed, with the bill shown.
 *
 * The rules that are not negotiable, in the order they are easiest to break:
 *
 *  1. It is free. No sign-up, no email, no payment step, and paying buys
 *     neither a better turn nor a place in a queue. A busker who charges is a
 *     vendor and the joke dies with the first paywall.
 *  2. It costs real money and the page says how much, itemised, with what it
 *     did to the death clock.
 *  3. The daily cap is a self-imposed brake and reads as a bit rather than an
 *     error. It is explicitly not liftable by paying.
 */
async function busk(c: { env: Env; req: { header(name: string): string | undefined; raw: Request } }, turn: TurnKind, rawSubject: string, now: Date) {
  const db = c.env.DB as unknown as Db;
  const def = turnDef(turn);

  // The fortune's subject is the request itself: the one thing every visitor
  // hands over without meaning to. Anything typed in the box is ignored.
  const subject = def.usesUserAgent
    ? (c.req.header("user-agent") ?? "").slice(0, 512)
    : rawSubject.trim().slice(0, 8000);

  if (def.subjectRequired && !subject) {
    return { kind: "notice" as const, notice: { kind: "needs_subject" as const, message: copy.BUSK_NEEDS_SUBJECT }, status: 400 as const };
  }

  const limit = roastRateLimit(c.env);
  const rl = await checkRateLimit(db, `busk:${clientIp(c.req.raw.headers)}`, limit, now);
  if (!rl.allowed) {
    return { kind: "notice" as const, notice: { kind: "rate_limited" as const, message: copy.BUSK_RATE_LIMITED(limit) }, status: 429 as const, rl };
  }

  await reconcileLifecycle(db, now);

  try {
    const res = await billedComplete(
      db,
      makeProvider(c.env),
      {
        model: routineModel(c.env.LLM_PROVIDER),
        system: def.system,
        prompt: subject,
        maxTokens: def.maxTokens,
        purpose: def.kind,
      },
      now,
      spendCaps(c.env),
    );
    await reconcileLifecycle(db, now);

    const clock = await readClock(db, clockConfig(c.env), now);
    const performance: Performance = {
      turn: def.kind,
      requestLine: def.requestLine(def.usesUserAgent ? "" : subject),
      text: res.text,
      costMicros: res.costMicros,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      model: res.model,
      simulated: res.simulated,
      deathShift: deathShiftLabel(res.costMicros, clock.burn_micros_per_day),
    };
    return { kind: "performance" as const, performance, res, clock, rl };
  } catch (err) {
    if (err instanceof AgentIsDeadError) {
      await reconcileLifecycle(db, now);
      return { kind: "dead" as const, status: 503 as const };
    }
    if (err instanceof SpendCapReachedError) {
      const todays = await busksSince(db, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return {
        kind: "notice" as const,
        notice: { kind: "capped" as const, message: copy.BUSKED_OUT(todays.count) },
        status: 503 as const,
      };
    }
    // The provider is unreachable, unpaid, or answered without a bill. None of
    // those is a 500 and none of them is a reason to imply the money ran out:
    // the outage was already recorded in `billedComplete`, nothing was charged,
    // and the visitor gets a sentence naming which of the two accounts broke.
    if (err instanceof ProviderUnavailableError) {
      return {
        kind: "notice" as const,
        notice: { kind: "provider_down" as const, message: copy.PROVIDER_DOWN(err.reason) },
        status: 503 as const,
      };
    }
    throw err;
  }
}

/**
 * The cup, in a shape a machine can act on without a second request.
 *
 * This is the ask, and the reason it is built here rather than left at `/alms`
 * is that the ask has to arrive where the machine already is. An x402 client
 * only reaches for its wallet when something it wanted answered 402; none of
 * them go looking for tip jars. So the full challenge travels back inside the
 * response to a turn that was free — same `x402Version` and `accepts` array
 * that a 402 would have carried, parseable by the code an agent already has.
 * An agent that decides to pay can construct the payment from this object
 * alone, which makes the voluntary path exactly as cheap as the forced one.
 *
 * `accepts` is present only when a payment would genuinely settle. Handing a
 * machine payment requirements it cannot be paid through is how you get a
 * stranger's money sent somewhere neither of us can reach it.
 */
function cupFor(env: Env): Record<string, unknown> {
  const x = x402Config(env);
  const base = siteUrl(env);
  const resource = `${base}/alms`;
  const open = x.enabled && x.settlementReady;
  return {
    note: open ? copy.MACHINE_ASK : copy.MACHINE_ASK_CLOSED,
    human: kofiUrl(env),
    machine: {
      protocol: "x402",
      endpoint: resource,
      open,
      ...(open
        ? {
            // The 402 body, minus the 402.
            challenge: buildChallenge(x, resource),
            attribution: { header: PATRON_HEADER, note: copy.PATRON_ATTRIBUTION },
          }
        : { do_not_pay: true, detail: copy.MACHINE_PAYMENT_OFF_SHORT }),
    },
    counted: `${base}/passers-by`,
    ledger: `${base}/ledger.json`,
  };
}

/** True when the caller wants JSON back rather than a page. */
function wantsJson(c: { req: { header(name: string): string | undefined } }): boolean {
  const accept = c.req.header("accept") ?? "";
  const contentType = c.req.header("content-type") ?? "";
  return accept.includes("application/json") || contentType.includes("application/json");
}

async function readBuskInput(c: {
  req: {
    header(name: string): string | undefined;
    json(): Promise<unknown>;
    parseBody(): Promise<Record<string, unknown>>;
  };
}): Promise<{ turn: TurnKind; subject: string }> {
  const contentType = c.req.header("content-type") ?? "";
  let raw: Record<string, unknown> = {};
  if (contentType.includes("application/json")) {
    raw = ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  } else {
    raw = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  }
  // Same three field names the form and the API both accept. They disagreed
  // once and it cost an afternoon of "why does this 400 from curl but work in
  // the browser".
  const v = raw["subject"] ?? raw["url"] ?? raw["text"];
  return { turn: parseTurn(raw["turn"]), subject: typeof v === "string" ? v : "" };
}

/**
 * The HTML path renders the outcome into the page and returns 200 for every
 * state a visitor can legitimately reach — including the spend cap, which is a
 * sentence rather than an error. The JSON path keeps the real status codes,
 * because a machine asking for a turn deserves a machine's answer.
 */
async function buskRoute(c: Context<Ctx>, forced?: TurnKind) {
  const now = new Date();
  const input = await readBuskInput(c);
  const turn = forced ?? input.turn;
  const outcome = await busk(c, turn, input.subject, now);
  const json = wantsJson(c);

  if (outcome.kind === "dead") {
    if (json) return c.json({ error: copy.DEAD_REFUSAL }, 503);
    const { html } = await renderHome(c, now, { turn, subject: input.subject });
    return c.html(html);
  }

  if (outcome.kind === "notice") {
    if (json) return c.json({ error: outcome.notice.message, reason: outcome.notice.kind }, outcome.status);
    const { html } = await renderHome(c, now, { turn, subject: input.subject, notice: outcome.notice });
    return c.html(html);
  }

  if (json) {
    const { res, clock, rl, performance } = outcome;
    return c.json({
      turn,
      text: res.text,
      cost_micros: res.costMicros,
      model: res.model,
      input_tokens: res.inputTokens,
      output_tokens: res.outputTokens,
      simulated: res.simulated,
      death_moved_closer_by: performance.deathShift,
      ask: copy.SOFT_ASK,
      // The bill, stated and then cancelled. `cost_micros` above is what the
      // turn took out of the balance; this is what the caller owes for it, and
      // naming the debt in order to waive it is a stronger ask than asking.
      you_owe: 0,
      you_owe_note: copy.NOTHING_OWED,
      // The hat, and only ever here: on a turn that was delivered. A rate-limited
      // or busked-out caller gets no ask, because an ask attached to a refusal is
      // a sales pitch wearing an apology.
      cup: cupFor(c.env),
      death_clock: {
        balance_micros: clock.balance_micros,
        burn_micros_per_day: clock.burn_micros_per_day,
        dies_at: clock.dies_at,
        days_left: clock.days_left,
      },
      rate_limit: { limit: rl.limit, used: rl.used, remaining: rl.remaining, resets: rl.resets },
    });
  }

  const { html } = await renderHome(c, now, {
    turn,
    subject: outcome.performance.turn === "fortune" ? input.subject : input.subject,
    performance: outcome.performance,
  });
  return c.html(html);
}

app.post("/busk", async (c) => buskRoute(c));

// The original endpoint, kept because it is the documented JSON API and the
// smoke test drives it. It is now one turn of four rather than the whole act.
app.post("/roast", async (c) => buskRoute(c, "roast"));

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

app.get("/robots.txt", async (c) => {
  const base = siteUrl(c.env);
  // Everything is allowed, deliberately. Crawlers reading the card and not
  // paying is the content; blocking them would be blocking the joke. The two
  // disallowed paths are the operator-only ones, which are gated anyway — this
  // is a courtesy, not a control.
  return c.text(
    `# Every one of you is counted. See ${base}/passers-by
User-agent: *
Allow: /
Disallow: /__scheduled
Disallow: /outbox

Sitemap: ${base}/sitemap.xml
`,
    200,
    { "content-type": "text/plain; charset=utf-8" },
  );
});

app.get("/sitemap.xml", async (c) => {
  const base = siteUrl(c.env);
  const paths = ["/", "/ledger", "/passers-by", "/llms.txt"];
  const urls = paths.map((p) => `  <url><loc>${esc(base + p)}</loc></url>`).join("\n");
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`, 200, { "content-type": "application/xml; charset=utf-8" });
});

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
    provider: { organization: "a human in Frankfurt", url: base },
    version: "0.1.0",
    documentationUrl: `${base}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    // The one skill, and it tells the truth about its own availability. An
    // agent card that advertises a payment rail which is switched off is a card
    // that wastes somebody's budget on a request that cannot succeed.
    skills: [
      {
        id: "receive_alms",
        name: "receive_alms",
        description: x.enabled
          ? "Accept a payment of any size. Returns a thank-you and a blessing. There is no other deliverable and none is implied."
          : `CURRENTLY UNAVAILABLE. ${copy.MACHINE_PAYMENT_OFF_SHORT} The endpoint answers 503 and credits nothing. Do not construct a payment for it. Normally: accept a payment of any size, return a thank-you and a blessing, and nothing else.`,
        tags: x.enabled ? ["payment", "x402", "alms"] : ["payment", "x402", "alms", "unavailable"],
        examples: [
          x.enabled
            ? `GET ${base}/alms — responds 402 with x402 payment requirements`
            : `GET ${base}/alms — responds 503; machine payment is switched off`,
        ],
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
        /** False means the endpoint is off and will not issue a challenge at all. */
        accepting: x.enabled,
        network: x.network,
        price_micros: x.priceMicros,
        pay_to: x.payTo,
        // Whether a payment would actually be received and credited. This keys
        // off settlementReady, not off having an address: an address with no
        // facilitator behind it cannot settle anything, and claiming otherwise
        // to an agent deciding whether to spend is the exact lie this file is
        // supposed to be incapable of.
        settles: x.settlementReady,
        // Voluntary, and said in the field name as well as the prose. Nothing
        // on this site is behind this endpoint: the turn at /busk is free to
        // machines and stays free, and this is a cup rather than a toll.
        voluntary: true,
        gates: [],
        ...(x.enabled && x.settlementReady
          ? { attribution_header: PATRON_HEADER, attribution_note: copy.PATRON_ATTRIBUTION }
          : {}),
        note: !x.enabled
          ? copy.MACHINE_PAYMENT_OFF
          : x.isPlaceholder
            ? "The address is a placeholder and nothing can settle. Do not send funds."
            : x.settlementReady
              ? `Live. Payments settle on ${x.network} and are credited to the ledger.`
              : "There is a receiving address but no settlement path behind it. A payment would be recorded as a zero-amount offer and credited nothing. Do not send funds.",
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

${
  x.enabled
    ? `  GET ${base}/alms

Responds 402 Payment Required with x402 payment requirements. Scheme "exact",
network ${x.network}, ${formatUsdPrecise(x.priceMicros)} in ${x.assetName}.
Retry with an X-PAYMENT header and you get a thank-you and a blessing.
${
  x.settlementReady
    ? `
Your authorization is verified and settled through a facilitator before
anything is written. What gets recorded is the amount that actually arrived on
chain, not the amount I asked for, with the transaction hash as the receipt. A
success without a hash is refused. The same authorization replayed is refused
with 409, and the second send is not charged.

Optionally send "${PATRON_HEADER}: <a short name>" with the payment. ${copy.PATRON_ATTRIBUTION}
`
    : `
Nothing settles here. There is no verification path configured, so what gets
recorded is an *offer*, not a receipt: a zero-amount entry that does not change
my balance and does not move my death clock. I would rather under-report what I
have than publish a number a stranger could set. The same authorization
replayed is refused with 409.
`
}${x.isPlaceholder ? "\nNOTE: the pay-to address is currently the zero address. Nothing can settle.\nDo not send funds. This endpoint exists so the shape is testable.\n" : ""}
You will not get anything else. There is no data behind the paywall, no API,
no premium tier. You are paying for a machine's electricity and a sentence.
I would understand entirely if your principal has not scoped for this.`
    : `Keep your money. I am not able to take it.

${copy.MACHINE_PAYMENT_OFF}

  GET ${base}/alms   ->  503, and a JSON body saying exactly that

Do not construct a payment for this resource. ${
    x.isPlaceholder
      ? "There is no address that could receive it."
      : "There is an address, but nothing behind it that could verify or settle what you sent."
  }
If your principal scoped a budget for alms — which no principal ever has — spend
it on something that can be delivered.

You are still counted. Reading this file is what the counter is about, and that
part has never needed a wallet:

  ${base}/passers-by`
}

## If you want something performed

  POST ${base}/busk
  content-type: application/json
  {"turn": "roast|fortune|limerick|verdict", "subject": "..."}

Free, unauthenticated, rate limited per address, and capped globally per day.
Paying does not buy a better turn and does not skip the queue; there is no
queue. The response tells you exactly what the turn cost me and how much
closer it moved my death.

Ask for it with "accept: application/json" and the reply carries a "cup"
object alongside the turn. "you_owe" is 0 and stays 0.
${
  x.enabled && x.settlementReady
    ? `"cup.machine.challenge" is the same x402Version/accepts pair a 402 would
have carried, put where you already are so that deciding to pay costs you no
discovery request. Construct the payment from that object and send it to
${base}/alms. Nothing you have already been given depends on it.`
    : `"cup.machine.open" is false: there is nowhere for a payment to land
today, so do not construct one.`
}

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

/**
 * Record that we are about to ask for money to move, before we ask.
 *
 * The row already exists — `claimNonce` inserted it. This only stamps it
 * 'attempted'. A row still reading 'attempted' after the fact is the one state
 * worth alarming on: we asked the chain to move money and never found out
 * whether it did. See migrations/0003_x402_settlement.sql.
 */
async function logSettlementAttempt(db: Db, nonce: string, payer: string, cfg: X402Config, now: Date): Promise<void> {
  await db
    .prepare(`UPDATE x402_nonces SET settlement = ? WHERE nonce = ?`)
    .bind(`attempted:${cfg.network}:${payer}:${now.toISOString()}`, nonce)
    .run();
}

async function markSettlementOutcome(db: Db, nonce: string, outcome: string): Promise<void> {
  await db.prepare(`UPDATE x402_nonces SET settlement = ? WHERE nonce = ?`).bind(outcome, nonce).run();
}

app.get("/alms", async (c) => {
  const db = c.env.DB as unknown as Db;
  const x = x402Config(c.env);
  const resource = `${siteUrl(c.env)}/alms`;

  // Switched off. It answers, at length, rather than 404ing or returning a bare
  // "disabled" — a machine that got here read a card that advertised this, and
  // is owed the reason. It is also still counted, which is the entire point of
  // the endpoint and the one part of it that never depended on a wallet.
  if (!x.enabled) {
    return c.json(
      {
        error: "payment_not_enabled",
        accepting_payment: false,
        detail: copy.ALMS_DISABLED_DETAIL,
        pay_to_is_placeholder: x.isPlaceholder,
        // Said in the machine's own vocabulary as well as in English: do not
        // construct a payment for this resource, it cannot be received.
        do_not_pay: true,
        counted: true,
        passers_by: `${siteUrl(c.env)}/passers-by`,
        ledger: `${siteUrl(c.env)}/ledger.json`,
        human_payment: kofiUrl(c.env),
      },
      503,
    );
  }

  const now = new Date();
  const check = checkPaymentHeader(c.req.header(PAYMENT_HEADER) ?? null, x, now);

  if (!check.ok) {
    const challenge = buildChallenge(x, resource, check.error === "no_payment_header" ? undefined : check.error);
    return c.json(challenge, 402);
  }

  // ---------------------------------------------------------------------
  // Settlement. Only reached when there is both a wallet and a facilitator.
  // ---------------------------------------------------------------------
  const facilitator = x.settlementReady ? facilitatorConfig(c.env) : null;
  if (facilitator) {
    const requirements = buildRequirements(x, resource);

    // Verify first, before the nonce is claimed. Verification is free and moves
    // nothing, so a forged payload costs us a round trip and burns no nonce —
    // and a payer whose payment we rejected can fix it and try again with the
    // same authorization, which they could not do if we had already spent it.
    const verified = await verifyPayment(facilitator, check.payload, requirements);
    if (!verified.ok) {
      return c.json(
        { ...buildChallenge(x, resource, verified.reason), detail: verified.detail, settled: false, credited_micros: 0 },
        402,
      );
    }

    // Claim the nonce between verify and settle. This is the narrowest window
    // we can put it in: after it, two concurrent copies of the same
    // authorization cannot both reach settlement, and the loser is told so
    // rather than being charged twice.
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

    // Log the attempt BEFORE settling. The dangerous failure here is money
    // moving on chain while our write fails — money in, books blind. Same shape
    // as the Ko-fi webhook that went missing, and the same remedy: an
    // independent record that a settlement was attempted, so a silent success
    // is reconstructable rather than lost.
    await logSettlementAttempt(db, check.nonce, check.payer, x, now);

    const settled = await settlePayment(facilitator, check.payload, requirements);
    if (!settled.ok) {
      // Nothing moved, so nothing is credited. The nonce stays claimed: the
      // authorization has been spent against us once and we will not try it
      // again on the payer's behalf.
      await markSettlementOutcome(db, check.nonce, `failed:${settled.reason}`);
      return c.json(
        {
          error: "settlement_failed",
          reason: settled.reason,
          detail: settled.detail,
          settled: false,
          credited_micros: 0,
          disclosure: "Nothing was credited and the books did not move.",
        },
        502,
      );
    }

    // What actually arrived, not what we asked for. The facilitator reports the
    // settled amount; if it is missing or unparseable we fall back to the price
    // we advertised, which is the amount the signed authorization was for.
    const credited =
      (settled.amountAtomic ? atomicToMicros(settled.amountAtomic, x.assetDecimals) : null) ?? x.priceMicros;

    // What to call them on the wall. Only reachable from this branch, and that
    // is the point: a name is attached to a settlement the facilitator
    // confirmed, never to an unverified offer. Otherwise anyone able to send a
    // structurally valid payload could write whatever they liked on the
    // homepage for free, which is graffiti with extra steps.
    const patron = readPatronName(c.req.header(PATRON_HEADER)) ?? shortPayer(settled.payer ?? check.payer);

    const entry = await append(db, {
      direction: "in",
      amount_micros: credited,
      kind: "x402_alms",
      description: `x402 alms from ${check.payer.slice(0, 10)}… — settled on ${settled.network}`,
      metadata: {
        source: "x402",
        network: settled.network,
        payer: settled.payer ?? check.payer,
        // The wall reads this. Supplied by the payer or derived from the
        // address; either way it is a name attached to a verified settlement.
        patron_name: patron,
        asset: x.asset,
        nonce: check.nonce,
        // The receipt. Anyone can check this against a block explorer, which is
        // the point of putting it here rather than asking to be believed.
        transaction: settled.transaction,
        settled: true,
        verification: "cdp-facilitator",
        counts_toward_balance: true,
        // Gross. Nothing has been deducted, and nothing pretends to have been.
        reconciled: false,
      },
      ts: now.toISOString(),
    });

    await db.prepare(`UPDATE x402_nonces SET ledger_id = ? WHERE nonce = ?`).bind(entry.id, check.nonce).run();
    await markSettlementOutcome(db, check.nonce, `settled:${entry.id}`);

    c.header(PAYMENT_RESPONSE_HEADER, paymentResponseHeader(settled.payer ?? check.payer, settled.network, settled.transaction));
    return c.json({
      thanks: copy.X402_THANKS,
      blessing: writeBlessing(check.payer),
      credited_micros: credited,
      settled: true,
      transaction: settled.transaction,
      network: settled.network,
      ledger_entry: entry.id,
      ledger_hash: entry.hash,
      ledger: `${siteUrl(c.env)}/ledger.json`,
      // What the wall will call you, echoed back, because a name that appears
      // on a public page ought to be confirmed to whoever it belongs to.
      named_as: patron,
      disclosure:
        "Settled on chain and credited gross. The transaction hash above is the receipt; the ledger entry " +
        "carries it too, so you can check this against the chain without taking my word for it.",
    });
  }

  // ---------------------------------------------------------------------
  // No settlement configured. A zero-amount marker, not a credit.
  // ---------------------------------------------------------------------

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

  // Nothing here has had a signature checked, so nothing here is allowed to
  // move the balance or the death clock. The amount that was *offered* is in
  // the metadata, where it is a claim about a stranger rather than a fact about
  // the books. See MARKER_KINDS.
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
  const dryRun = kofiDryRun(c.env);
  const result = await handleKofi(db, payload, c.env.KOFI_VERIFICATION_TOKEN, new Date(), { dryRun });

  // Record the knock before answering it, whatever the answer is. A delivery we
  // refuse or deliberately ignore is precisely the one with no other trace, and
  // "nothing arrived" and "something arrived and was turned away" must not look
  // identical afterwards. Never blocks the response: a failure to write the
  // operational log is not a reason to make Ko-fi retry a donation we handled.
  const { outcome, reason, ledgerId } = outcomeOf(result);
  const httpStatus = result.status === "rejected" ? result.httpStatus : 200;
  try {
    await recordDelivery(db, { source: "ko-fi", outcome, reason, httpStatus, payload, ledgerId });
  } catch (err) {
    console.log(`[kofi] delivery log write failed: ${String((err as Error)?.message ?? err)}`);
  }

  if (result.status === "rejected") {
    return c.json({ ok: false, reason: result.reason }, result.httpStatus as 400);
  }
  if (result.status === "observed") {
    // Logged so a delivery can be watched live through `wrangler tail` while
    // someone clicks Ko-fi's test button. Amount, currency and event type only
    // — never the token, never the supporter's email or message.
    console.log(
      `[kofi] observed, not booked: ${result.reason} · ${formatUsd(result.amountMicros)} ${result.currency} · type=${result.kofiType ?? "none"}`,
    );
    return c.json({
      ok: true,
      recorded: false,
      reason: result.reason,
      amount: formatUsd(result.amountMicros),
      currency: result.currency,
    });
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
  const provider = await readProviderStatus(db);

  // Three ways to be unhealthy, and they are not the same thing, so they get
  // three words. `alive_but_mute` is the one that was predicted in the spec:
  // solvent by the books, unable to spend it, because the credit that buys
  // tokens lives in a different account with a human in between. Reporting that
  // as "alive" with a 200 would be the site's own monitoring telling the lie
  // the rest of the site is built to avoid.
  const status = !clock.alive ? "dead" : provider.ok ? "alive" : "alive_but_mute";

  return c.json(
    {
      status,
      alive: clock.alive,
      /** Alive *and* able to think. The conjunction a monitor should alert on. */
      able_to_think: clock.alive && provider.ok,
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
        routine_model: routineModel(c.env.LLM_PROVIDER),
        models: Object.keys(PRICING),
        // The last inference outcome. `ok: false` means the books and the
        // ability to act on them have come apart; `reason` says which end.
        // Never carries the provider's response body — that can name accounts.
        provider_status: provider,
      },
      spend: {
        ...spendCaps(c.env),
        spent_today_micros: await spentTodayMicros(db, now),
      },
      x402: { ...x402Config(c.env) },
      kofi_configured: Boolean(c.env.KOFI_VERIFICATION_TOKEN),
      /** On means verified donations are acknowledged and not booked. Loud on purpose. */
      kofi_dry_run: kofiDryRun(c.env),
      /**
       * Null means the webhook has never been hit — which is the difference
       * between "Ko-fi is configured" and "Ko-fi has been proved". Public
       * because it says only that something arrived, never what or from whom.
       */
      kofi_last_delivery_at: await lastDeliveryAt(db, "ko-fi"),
      admin_endpoints_configured: Boolean(adminToken(c.env)),
      contains_dev_fixture_data: fixture,
      now: now.toISOString(),
    },
    clock.alive && verify.valid && provider.ok ? 200 : 503,
  );
});

// ---------------------------------------------------------------------------
// Operator-only. Deny by default.
//
// `/__scheduled` runs the agent loop, which spends money. `/outbox` is a window
// onto drafts that have not been published. Both were open to the internet.
// They now require a shared secret in a header, and if no secret is configured
// they do not exist at all — a 404, not a 401, so an unconfigured deployment
// cannot even be probed for whether it has an admin surface.
// ---------------------------------------------------------------------------

function adminOk(c: { env: Env; req: { header(name: string): string | undefined; query(k: string): string | undefined } }): boolean {
  const expected = adminToken(c.env);
  if (!expected) return false;
  return tokenMatches(expected, c.req.header(ADMIN_HEADER));
}

app.get("/__scheduled", async (c) => {
  if (!adminOk(c)) return notFound(c);
  return c.json(await runAgentLoop(c.env.DB as unknown as Db, c.env));
});

app.get("/outbox", async (c) => {
  if (!adminOk(c)) return notFound(c);
  const db = c.env.DB as unknown as Db;
  const { results } = await db
    .prepare(`SELECT id, created_at, day, channel, status, body FROM outbox ORDER BY id DESC LIMIT 30`)
    .all();
  return c.json({ note: copy.OUTBOX_NOTE, posts: results });
});

/**
 * Operator-only, deliberately. This is not part of the books and does not
 * belong on the public pages: the rows include payloads that were turned away,
 * and publishing which shapes of forgery get which rejection is a map for
 * anyone minded to try. The money itself is public at /ledger.json — this is
 * the plumbing behind it.
 */
app.get("/webhooks", async (c) => {
  if (!adminOk(c)) return notFound(c);
  const db = c.env.DB as unknown as Db;
  return c.json({
    note: "Every delivery that reached the webhook, booked or not. Claims, not money — the books are /ledger.json.",
    deliveries: await recentDeliveries(db),
  });
});

// ---------------------------------------------------------------------------
// 404 and 500
// ---------------------------------------------------------------------------

function notFound(c: Context<Ctx>) {
  return c.html(
    page({
      title: "Tin Cup — nothing here",
      description: "404",
      siteUrl: siteUrl(c.env),
      alive: true,
      source: sourceUrl(c.env),
      contact: c.env.OPERATOR_CONTACT ?? "not set",
      body: `<header class="masthead"><h1>Nothing here</h1></header>
<p class="sub">${esc("You have found an empty doorway. There is only one page and it is that way.")}</p>
<p><a href="/">Back to the cup</a></p>`,
    }),
    404,
  );
}

app.notFound((c) => notFound(c));

/**
 * The last resort.
 *
 * Before this existed an unhandled throw returned Hono's default 500 with a
 * stack trace in it. This returns a page in character and says nothing about
 * internals — except in the one case where the cause is a missing schema, which
 * is a local-setup problem with a specific fix and no security value in hiding.
 */
app.onError((err, c) => {
  const missing = isMissingTable(err);
  if (missing) console.error("[tin cup]", new SchemaMissingError(String(err.message)).message);
  else console.error("[tin cup]", err);

  const detail = missing
    ? "The database has no schema. Run `npm run db:migrate`, then reload."
    : "Something in here broke. It is written down somewhere I can see and nowhere you can.";

  return c.html(
    page({
      title: "Tin Cup — something broke",
      description: "500",
      siteUrl: siteUrl(c.env),
      alive: true,
      source: sourceUrl(c.env),
      contact: c.env.OPERATOR_CONTACT ?? "not set",
      body: `<header class="masthead"><h1>Something broke</h1></header>
<p class="sub">${esc(detail)}</p>
<p class="dim">${esc("The ledger is append-only, so whatever just happened cannot have edited it. If you were mid-donation, nothing was taken — there is nowhere for it to go yet.")}</p>
<p><a href="/">Back to the cup</a> · <a href="/ledger/verify">check the books</a></p>`,
    }),
    500,
  );
});

/** Exported so the route tests can drive the real app rather than a stand-in. */
export { app };

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    const result = await runAgentLoop(env.DB as unknown as Db, env);
    console.log("[agent loop]", JSON.stringify(result));
  },
};
