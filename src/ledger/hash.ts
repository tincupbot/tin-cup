/**
 * The hash chain. This is the part that has to be right.
 *
 *   hash = sha256(canonical_json({
 *     id, ts, direction, amount_micros, currency, kind, description, metadata, prev_hash
 *   }))
 *
 * Canonical JSON: keys sorted lexicographically at every level, no whitespace,
 * no trailing commas, `undefined` omitted. Genesis prev_hash is 64 zeroes.
 *
 * Note what is NOT in the hash: `seq`. The row's autoincrement position is a
 * storage detail, not a fact about the entry. The chain order is established by
 * prev_hash, which is the whole point.
 */

export const GENESIS_PREV_HASH = "0".repeat(64);

export type HashableEntry = {
  id: string;
  ts: string;
  direction: "in" | "out";
  amount_micros: number;
  currency: string;
  kind: string;
  description: string;
  metadata: unknown;
  prev_hash: string;
};

/** Deterministic JSON: sorted object keys, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`refusing to canonicalise non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`refusing to canonicalise ${typeof value}`);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact preimage that gets hashed. Exposed so `/ledger/verify` can show its working. */
export function hashPreimage(entry: HashableEntry): string {
  return canonicalJson({
    amount_micros: entry.amount_micros,
    currency: entry.currency,
    description: entry.description,
    direction: entry.direction,
    id: entry.id,
    kind: entry.kind,
    metadata: entry.metadata,
    prev_hash: entry.prev_hash,
    ts: entry.ts,
  });
}

export function entryHash(entry: HashableEntry): Promise<string> {
  return sha256Hex(hashPreimage(entry));
}
