import type { Db } from "./db.ts";
import { allEntries, type LedgerEntry } from "./ledger/ledger.ts";

export type Patron = {
  name: string;
  total_micros: number;
  gifts: number;
  first_at: string;
  last_at: string;
  /** True when this patron only exists because of seeded demo data. */
  fixture: boolean;
};

const DONATION_KINDS = new Set(["donation", "x402_alms", "commission", "dev_fixture"]);

/**
 * The wall, derived from the ledger rather than stored separately.
 *
 * Deriving it means the wall cannot disagree with the books. There is no
 * "patrons" table to drift, and nobody can appear on the wall without a hashed
 * entry to point at.
 *
 * Anyone who didn't leave a name is folded into a single anonymous count rather
 * than listed as "Anonymous" eleven times.
 */
export async function patronWall(db: Db, limit = 25): Promise<{ named: Patron[]; anonymous: { count: number; total_micros: number } }> {
  return wallFrom(await allEntries(db), limit);
}

export function wallFrom(entries: LedgerEntry[], limit = 25) {
  const byName = new Map<string, Patron>();
  let anonCount = 0;
  let anonTotal = 0;

  for (const e of entries) {
    if (e.direction !== "in" || !DONATION_KINDS.has(e.kind) || e.amount_micros <= 0) continue;
    const raw = e.metadata["patron_name"];
    const name = typeof raw === "string" ? raw.trim().slice(0, 48) : "";
    const fixture = e.metadata["fixture"] === true;

    if (!name) {
      anonCount++;
      anonTotal += e.amount_micros;
      continue;
    }

    const existing = byName.get(name);
    if (existing) {
      existing.total_micros += e.amount_micros;
      existing.gifts += 1;
      existing.last_at = e.ts;
      existing.fixture = existing.fixture || fixture;
    } else {
      byName.set(name, {
        name,
        total_micros: e.amount_micros,
        gifts: 1,
        first_at: e.ts,
        last_at: e.ts,
        fixture,
      });
    }
  }

  const named = [...byName.values()]
    .sort((a, b) => b.total_micros - a.total_micros || a.first_at.localeCompare(b.first_at))
    .slice(0, limit);

  return { named, anonymous: { count: anonCount, total_micros: anonTotal } };
}

/** Whether the ledger contains any seeded demo entries. Drives the fixture banner. */
export async function hasFixtureData(db: Db): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM ledger WHERE kind = 'dev_fixture' OR metadata LIKE '%"fixture":true%' LIMIT 1`)
    .first<{ hit: number }>();
  return Boolean(row);
}
