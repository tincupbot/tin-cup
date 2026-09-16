import { describe, expect, it } from "vitest";
import { freshDb, type NodeDb } from "./helpers.ts";
import { append, allEntries, verifyLedger, APPEND_MAX_ATTEMPTS, LedgerContentionError } from "../src/ledger/ledger.ts";
import { readLedgerState } from "../src/ledger/state.ts";
import { reconcileLifecycle } from "../src/deathclock.ts";
import type { Db, DbStatement } from "../src/db.ts";

/**
 * The append race.
 *
 * Two writers can read the same chain tip. The UNIQUE index on `hash` refuses
 * the loser's insert, which is correct — a fork would be worse — but nothing
 * used to retry, so a donation landing during an inference write returned a 500
 * and the money event was simply gone. That is the worst bug this project can
 * have: not a wrong number, a missing one.
 *
 * Real concurrency is not reproducible in a test, so these inject the exact
 * failure the database produces and assert the recovery.
 */

const TIP_RACE = "UNIQUE constraint failed: ledger.hash";

/** Wraps a Db and makes the first `failures` ledger inserts fail as a lost race. */
function flaky(inner: Db, failures: number, message = TIP_RACE): { db: Db; remaining: () => number } {
  let left = failures;
  const db: Db = {
    prepare(sql: string): DbStatement {
      const stmt = inner.prepare(sql);
      if (!/^\s*INSERT INTO ledger/i.test(sql)) return stmt;
      const wrapper: DbStatement = {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...values);
          return {
            bind: wrapper.bind,
            first: () => bound.first(),
            all: () => bound.all(),
            run: async () => {
              if (left > 0) {
                left--;
                throw new Error(message);
              }
              return bound.run();
            },
          } as DbStatement;
        },
        first: () => stmt.first(),
        all: () => stmt.all(),
        run: () => stmt.run(),
      };
      return wrapper;
    },
  };
  return { db, remaining: () => left };
}

const entry = (n: number) => ({
  direction: "in" as const,
  amount_micros: n,
  kind: "donation" as const,
  description: `gift ${n}`,
});

describe("ledger append under contention", () => {
  it("retries a lost race and lands the entry", async () => {
    const raw = await freshDb();
    const { db, remaining } = flaky(raw, 2);

    const written = await append(db, entry(1_000_000));

    expect(remaining()).toBe(0);
    expect(written.amount_micros).toBe(1_000_000);
    expect(await allEntries(raw)).toHaveLength(1);
    expect(await verifyLedger(raw)).toMatchObject({ valid: true });
  });

  it("keeps the same entry id across retries — a retry is the same event, later in the chain", async () => {
    const raw = await freshDb();
    const { db } = flaky(raw, 3);
    const written = await append(db, { ...entry(500), id: "fixed-id-for-the-test" });
    expect(written.id).toBe("fixed-id-for-the-test");
    expect((await allEntries(raw))[0]!.id).toBe("fixed-id-for-the-test");
  });

  it("gives up loudly rather than silently dropping a money event", async () => {
    const raw = await freshDb();
    const { db } = flaky(raw, APPEND_MAX_ATTEMPTS + 1);
    await expect(append(db, entry(42))).rejects.toThrow(LedgerContentionError);
    expect(await allEntries(raw)).toHaveLength(0);
  });

  it("does not retry a duplicate id — that is a caller bug and retrying would loop", async () => {
    const db = await freshDb();
    await append(db, { ...entry(10), id: "same" });
    await expect(append(db, { ...entry(20), id: "same" })).rejects.toThrow(/UNIQUE constraint failed:\s*ledger\.id/);
    expect(await allEntries(db)).toHaveLength(1);
  });

  it("leaves the materialised summary agreeing with the chain after a retry", async () => {
    const raw = await freshDb();
    const { db } = flaky(raw, 1);
    await append(db, entry(3_000_000));
    await append(raw, { direction: "out", amount_micros: 1_000_000, kind: "inference", description: "a turn" });

    const state = await readLedgerState(raw);
    const entries = await allEntries(raw);
    expect(state.entries).toBe(2);
    expect(state.head).toBe(entries[1]!.hash);
    expect(state.total_in_micros).toBe(3_000_000);
    expect(state.total_out_micros).toBe(1_000_000);
  });

  it("rebuilds the summary when something writes behind its back", async () => {
    const db = await freshDb();
    await append(db, entry(2_000_000));

    // Simulate a write path that did not maintain the summary — a migration, a
    // manual INSERT, a future bug. The next read must notice, not publish.
    await db.raw().exec(`UPDATE state SET value = '{"seq":99,"head":"nonsense","entries":99,
      "total_in_micros":99999999,"total_out_micros":0,"first_ts":null,"has_fixture":false}'
      WHERE key = 'ledger_summary'`);

    const state = await readLedgerState(db);
    expect(state.entries).toBe(1);
    expect(state.total_in_micros).toBe(2_000_000);
    expect(state.head).toBe((await allEntries(db))[0]!.hash);
  });
});

describe("lifecycle transitions are claimed, not raced", () => {
  const fund = (db: NodeDb, micros: number) =>
    append(db, { direction: "in", amount_micros: micros, kind: "donation", description: "gift" });

  it("writes exactly one death marker however many reconciles run", async () => {
    const db = await freshDb();
    await fund(db, 1_000);
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "spent it" });

    // Four concurrent reconciles, the shape a busy moment actually produces.
    const results = await Promise.all([
      reconcileLifecycle(db),
      reconcileLifecycle(db),
      reconcileLifecycle(db),
      reconcileLifecycle(db),
    ]);

    expect((await allEntries(db)).filter((e) => e.kind === "death")).toHaveLength(1);
    expect(results.filter((r) => r.changed === "died")).toHaveLength(1);
  });

  it("writes exactly one resurrection marker, and numbers it once", async () => {
    const db = await freshDb();
    await fund(db, 1_000);
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "spent it" });
    await reconcileLifecycle(db);

    await fund(db, 5_000);
    await Promise.all([reconcileLifecycle(db), reconcileLifecycle(db), reconcileLifecycle(db)]);

    const markers = (await allEntries(db)).filter((e) => e.kind === "resurrection");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.metadata["resurrection_number"]).toBe(1);
    expect(await verifyLedger(db)).toMatchObject({ valid: true });
  });
});
