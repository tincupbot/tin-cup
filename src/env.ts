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
  OPERATOR_CONTACT?: string;
  CONTACT_NOTE?: string;

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

  // --- Secrets. Never committed, never logged, never rendered. ---
  /** Ko-fi webhook verification token. Absent locally; the webhook rejects when absent. */
  KOFI_VERIFICATION_TOKEN?: string;
  /** Absent. The Anthropic provider is inert without it and stays that way. */
  ANTHROPIC_API_KEY?: string;
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
  /** True when payTo is the zero address, i.e. there is no wallet. Always true today. */
  isPlaceholder: boolean;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function x402Config(env: Env): X402Config {
  const payTo = env.X402_PAY_TO ?? ZERO_ADDRESS;
  return {
    enabled: env.X402_ENABLED !== "false",
    network: env.X402_NETWORK ?? "base-sepolia",
    priceMicros: num(env.X402_PRICE_MICROS, 10_000),
    payTo,
    asset: env.X402_ASSET ?? "",
    assetName: env.X402_ASSET_NAME ?? "USDC",
    assetDecimals: num(env.X402_ASSET_DECIMALS, 6),
    isPlaceholder: payTo === ZERO_ADDRESS || payTo === "",
  };
}
