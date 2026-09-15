import type { Db } from "./db.ts";
import { dayKey } from "./passersby/sentences.ts";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  resets: string;
};

/**
 * Per-bucket, per-UTC-day counter. The bucket is an IP for the roast endpoint.
 *
 * Counts up on every *attempt*, including refused ones, so hammering it doesn't
 * get you a free retry. Rows are tiny and keyed by day; a cleanup pass runs in
 * the scheduled handler rather than on the request path.
 */
export async function checkRateLimit(
  db: Db,
  bucket: string,
  limit: number,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const day = dayKey(now);
  await db
    .prepare(
      `INSERT INTO rate_limits (bucket, day, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, day) DO UPDATE SET count = count + 1`,
    )
    .bind(bucket, day)
    .run();

  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE bucket = ? AND day = ?`)
    .bind(bucket, day)
    .first<{ count: number }>();

  const used = row?.count ?? 1;
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

  return {
    allowed: used <= limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resets,
  };
}

export async function pruneRateLimits(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = dayKey(new Date(now.getTime() - 3 * 86_400_000));
  await db.prepare(`DELETE FROM rate_limits WHERE day < ?`).bind(cutoff).run();
}

/** Cloudflare gives us CF-Connecting-IP. The fallbacks are for local dev. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "local"
  );
}
