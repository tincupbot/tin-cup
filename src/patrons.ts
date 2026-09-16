import type { Db } from "./db.ts";
import { donationEntries, type LedgerEntry } from "./ledger/ledger.ts";
import { readLedgerState } from "./ledger/state.ts";

export type Patron = {
  name: string;
  total_micros: number;
  gifts: number;
  first_at: string;
  last_at: string;
  /** True when this patron only exists because of seeded demo data. */
  fixture: boolean;
};

export const DONATION_KIND_LIST = ["donation", "x402_alms", "commission", "dev_fixture"] as const;
const DONATION_KINDS = new Set<string>(DONATION_KIND_LIST);

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
  // Only the entries that can possibly appear on the wall. This used to read
  // the entire ledger on every homepage render to find the handful of rows that
  // were gifts; `ledger_kind_ts` makes it a range scan over the donations.
  return wallFrom(await donationEntries(db, DONATION_KIND_LIST), limit);
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

/**
 * Whether the ledger contains any seeded demo entries. Drives the fixture banner.
 *
 * Read off the materialised ledger summary, which is O(1). The old version was
 * a `metadata LIKE '%"fixture":true%'` scan of the whole table, run on every
 * page of the site — and worse, it scanned hardest in the case that matters,
 * production, where the answer is "no" and every row has to be checked to say so.
 */
export async function hasFixtureData(db: Db): Promise<boolean> {
  return (await readLedgerState(db)).has_fixture;
}
