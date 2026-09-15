import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.ts";
import { append, allEntries, verifyLedger, verifyChain, entryCount } from "../src/ledger/ledger.ts";
import { GENESIS_PREV_HASH } from "../src/ledger/hash.ts";

describe("append", () => {
  it("chains each entry to the one before it, starting from genesis", async () => {
    const db = await freshDb();
    const a = await append(db, { direction: "in", amount_micros: 5_000_000, kind: "startup_capital", description: "seed" });
    const b = await append(db, { direction: "out", amount_micros: 1_234, kind: "inference", description: "haiku" });

    expect(a.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(b.prev_hash).toBe(a.hash);
    expect(await entryCount(db)).toBe(2);
  });

  it("rejects negative and non-integer amounts", async () => {
    const db = await freshDb();
    await expect(append(db, { direction: "in", amount_micros: -1, kind: "donation", description: "x" })).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(append(db, { direction: "in", amount_micros: 1.5, kind: "donation", description: "x" })).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it("rejects a direction that disagrees with the kind", async () => {
    const db = await freshDb();
    await expect(append(db, { direction: "out", amount_micros: 1, kind: "donation", description: "x" })).rejects.toThrow(
      /not an 'out' kind/,
    );
    await expect(append(db, { direction: "in", amount_micros: 1, kind: "inference", description: "x" })).rejects.toThrow(
      /not an 'in' kind/,
    );
  });

  it("forces marker kinds to carry no money", async () => {
    const db = await freshDb();
    for (const kind of ["death", "resurrection", "alms_offer"] as const) {
      await expect(
        append(db, { direction: "in", amount_micros: 1, kind, description: "x" }),
      ).rejects.toThrow(/must have amount_micros 0/);
    }
  });
});

describe("verifyChain", () => {
  it("passes on an untouched chain and reports the head", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 5_000_000, kind: "startup_capital", description: "seed" });
    const last = await append(db, { direction: "out", amount_micros: 900, kind: "inference", description: "haiku" });

    const v = await verifyLedger(db);
    expect(v.valid).toBe(true);
    expect(v.entries).toBe(2);
    expect(v.head).toBe(last.hash);
    expect(v.first_bad_index).toBeNull();
  });

  it("verifies an empty ledger, with genesis as the head", async () => {
    const v = await verifyLedger(await freshDb());
    expect(v.valid).toBe(true);
    expect(v.entries).toBe(0);
    expect(v.head).toBe(GENESIS_PREV_HASH);
  });

  it("catches an edited row and names it", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000_000, kind: "donation", description: "honest" });
    await append(db, { direction: "in", amount_micros: 1_000_000, kind: "donation", description: "also honest" });

    // Tamper in memory — the database itself refuses this, see below.
    const entries = await allEntries(db);
    entries[1]!.amount_micros = 999_000_000;

    const v = await verifyChain(entries);
    expect(v.valid).toBe(false);
    expect(v.first_bad_index).toBe(1);
    expect(v.first_bad_id).toBe(entries[1]!.id);
    expect(v.reason).toMatch(/tampered row/);
  });

  it("catches a removed entry as a broken link", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000_000, kind: "donation", description: "one" });
    await append(db, { direction: "in", amount_micros: 2_000_000, kind: "donation", description: "two" });
    await append(db, { direction: "in", amount_micros: 3_000_000, kind: "donation", description: "three" });

    const entries = await allEntries(db);
    const withoutMiddle = [entries[0]!, entries[2]!];

    const v = await verifyChain(withoutMiddle);
    expect(v.valid).toBe(false);
    expect(v.first_bad_index).toBe(1);
    expect(v.reason).toMatch(/broken link/);
  });
});

describe("append-only enforcement", () => {
  it("is enforced by SQLite, not by convention", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000_000, kind: "donation", description: "permanent" });
    const raw = db.raw();

    expect(() => raw.prepare(`UPDATE ledger SET amount_micros = 0`).run()).toThrow(/append-only/);
    expect(() => raw.prepare(`DELETE FROM ledger`).run()).toThrow(/append-only/);

    const v = await verifyLedger(db);
    expect(v.valid).toBe(true);
    expect(v.entries).toBe(1);
  });
});
