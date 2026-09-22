import type { ClockConfig } from "./deathclock.ts";

/**
 * All config arrives as strings from wrangler.toml [vars] or, for secrets,
 * from .dev.vars / `wrangler secret put`. Nothing is hardcoded and nothing
 * secret is committed.
 */
export type Env = {
  DB: D1Database;

  SITE_NAME?: string;
  SITE_URL?: string;
  SOURCE_URL?: string;
  OPERATOR_CONTACT?: string;
  CONTACT_NOTE?: string;

  /** Seconds the homepage may sit in the edge cache. 0 disables caching. */
  HOME_CACHE_SECONDS?: string;
  /** Raw passers-by log sample rate: one request in N. Card reads ignore it. */
  PASSERSBY_SAMPLE_ONE_IN?: string;

  BURN_FLOOR_MICROS?: string;
  BURN_WINDOW_DAYS?: string;
  ROAST_RATE_LIMIT?: string;

  /** Hard ceiling on inference spend per UTC day, across all callers. */
  DAILY_SPEND_CAP_MICROS?: string;
  /** Hard ceiling on what any single inference call may cost. */
  MAX_CALL_COST_MICROS?: string;

  X402_ENABLED?: string;
  X402_NETWORK?: string;
  X402_PRICE_MICROS?: string;
  X402_PAY_TO?: string;
  X402_ASSET?: string;
  X402_ASSET_NAME?: string;
  X402_ASSET_DECIMALS?: string;

  LLM_PROVIDER?: string;
  LLM_LIVE_CALLS_ENABLED?: string;

  /** Ko-fi page handle, e.g. "tincupbot". Absent means the hat has no destination yet. */
  KOFI_HANDLE?: string;
  /**
   * Acknowledge Ko-fi webhooks without booking them. Transient, deploy-time
   * only — see `kofiDryRun`. Never committed to wrangler.toml; the guard
   * enforces that, because left on it would swallow real donations.
   */
  KOFI_DRY_RUN?: string;

  // --- Secrets. Never committed, never logged, never rendered. ---
  /** Ko-fi webhook verification token. Absent locally; the webhook rejects when absent. */
  KOFI_VERIFICATION_TOKEN?: string;
  /**
   * Coinbase CDP secret API key, the two halves of it. They authenticate the
   * facilitator calls that verify and settle x402 payments. They do not sign
   * anything and they cannot move funds — the money goes to X402_PAY_TO, which
   * is public config, not to whoever holds this key.
   *
   * Absent means no settlement is possible, which means `/alms` will not credit
   * anything. That is the safe default and it is load-bearing: see
   * `settlementReady`.
   */
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  /** Absent. The Anthropic provider is inert without it and stays that way. */
  ANTHROPIC_API_KEY?: string;
  /** Absent. The OpenAI provider is inert without it and stays that way. */
  OPENAI_API_KEY?: string;
  /**
   * Shared secret for the operator-only endpoints.
   *
   * Absent means those endpoints do not exist — they 404 rather than 401, so an
   * unconfigured deployment cannot be probed for whether it has an admin
   * surface at all. There is no default and there must never be one: the
   * scheduled run spends money, and /outbox is a window onto unsent drafts.
   */
  ADMIN_TOKEN?: string;
};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function clockConfig(env: Env): ClockConfig {
  return {
    windowDays: num(env.BURN_WINDOW_DAYS, 7),
    floorMicrosPerDay: num(env.BURN_FLOOR_MICROS, 250_000),
  };
}

export function siteName(env: Env): string {
  return env.SITE_NAME ?? "Tin Cup";
}

export function siteUrl(env: Env): string {
  return env.SITE_URL ?? "http://localhost:8787";
}

export function roastRateLimit(env: Env): number {
  return num(env.ROAST_RATE_LIMIT, 5);
}

export function sourceUrl(env: Env): string {
  return env.SOURCE_URL ?? "https://github.com/tincupbot/tin-cup";
}

/**
 * Where the hat actually is, or null if there is nowhere to send money yet.
 *
 * Null is a supported state and the page says so out loud rather than showing a
 * dead button: an ask that goes nowhere is the one dishonest thing this site
 * could do. The handle is public by definition, so it lives in config rather
 * than in the secrets block.
 */
export function kofiUrl(env: Env): string | null {
  const handle = env.KOFI_HANDLE?.trim();
  if (!handle) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(handle)) return null;
  return `https://ko-fi.com/${handle}`;
}

/**
 * Webhook dry run: verify, understand, acknowledge — and write nothing.
 *
 * Proving the Ko-fi wiring needs a real delivery from Ko-fi, and a real
 * delivery of a test payment is money that nobody was charged. This flag is how
 * the URL, the shared token and the currency get proved without a fictional
 * entry in a ledger that has no delete path.
 *
 * It is deliberately hostile to being left on: set only at deploy time
 * (`wrangler deploy --var KOFI_DRY_RUN:true`), never in wrangler.toml, and
 * reported by /health so it cannot hide. On, a genuine donation is
 * acknowledged and dropped — which is worse than any bug it prevents, so it
 * comes straight back off.
 */
export function kofiDryRun(env: Env): boolean {
  return env.KOFI_DRY_RUN === "true";
}

/**
 * How long the homepage may be served from the edge cache.
 *
 * The page is the same bytes for every visitor, and it is the one page that
 * gets linked. Fifteen seconds is short enough that the death clock still looks
 * live and long enough that a front-page spike reads the database a few times a
 * minute rather than a few thousand. Set to 0 to turn it off.
 */
export function homeCacheSeconds(env: Env): number {
  const raw = env.HOME_CACHE_SECONDS;
  if (raw === undefined) return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 15;
}

export function passersbySampleOneIn(env: Env): number {
  return num(env.PASSERSBY_SAMPLE_ONE_IN, 10);
}

/**
 * The operator-only endpoints: `/__scheduled` (spends money) and `/outbox`
 * (unsent drafts). Deny by default — no token configured means no endpoint.
 */
export function adminToken(env: Env): string | null {
  const t = env.ADMIN_TOKEN?.trim();
  return t ? t : null;
}

export const ADMIN_HEADER = "x-tincup-admin";

/**
 * Constant-time-ish comparison. Not a defence against a local attacker with a
 * stopwatch — Workers has no `timingSafeEqual` — but it removes the trivial
 * early-exit and costs nothing.
 */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export type SpendCaps = {
  /** Total inference spend allowed in one UTC day. */
  dailyMicros: number;
  /** Most any one call is allowed to cost. */
  perCallMicros: number;
};

/**
 * The brake that has to exist before real money is switched on.
 *
 * Per-IP rate limiting is not a spend control — it is a politeness control. An
 * attacker rotating addresses (a proxy pool, or just an IPv6 range) walks
 * straight through it, and on this project draining the balance is the obvious
 * troll, because the balance *is* the joke. This cap is global, counts every
 * caller together, and is checked on the one code path all inference goes
 * through.
 *
 * Defaults are deliberately mean: $0.50/day is roughly half a normal day's burn,
 * so if it ever binds in normal operation that is information worth having
 * before the number is somebody else's to move.
 */
export function spendCaps(env: Env): SpendCaps {
  return {
    dailyMicros: num(env.DAILY_SPEND_CAP_MICROS, 500_000),
    perCallMicros: num(env.MAX_CALL_COST_MICROS, 25_000),
  };
}

export type X402Config = {
  enabled: boolean;
  network: string;
  priceMicros: number;
  payTo: string;
  asset: string;
  assetName: string;
  assetDecimals: number;
  /** True when payTo is the zero address, i.e. there is no wallet to receive anything. */
  isPlaceholder: boolean;
  /**
   * True only when a payment could actually settle and be credited: a real
   * receiving address AND facilitator credentials to verify and settle against.
   *
   * Every claim the site makes about taking machine money keys off this one
   * boolean — the homepage copy, llms.txt, the agent card, and whether `/alms`
   * books a credit or a zero-amount marker. One flag, so they cannot disagree
   * with each other. A wallet with no facilitator is a promise we cannot keep;
   * a facilitator with no wallet is a payment with nowhere to land. Neither is
   * sufficient on its own and neither is allowed to look sufficient.
   */
  settlementReady: boolean;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function x402Config(env: Env): X402Config {
  const payTo = env.X402_PAY_TO ?? ZERO_ADDRESS;
  const isPlaceholder = payTo === ZERO_ADDRESS || payTo === "";
  const hasFacilitator = Boolean(env.CDP_API_KEY_ID?.trim() && env.CDP_API_KEY_SECRET?.trim());
  return {
    enabled: env.X402_ENABLED !== "false",
    network: env.X402_NETWORK ?? "base-sepolia",
    priceMicros: num(env.X402_PRICE_MICROS, 10_000),
    payTo,
    asset: env.X402_ASSET ?? "",
    assetName: env.X402_ASSET_NAME ?? "USDC",
    assetDecimals: num(env.X402_ASSET_DECIMALS, 6),
    isPlaceholder,
    settlementReady: !isPlaceholder && hasFacilitator,
  };
}
