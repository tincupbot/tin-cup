import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.ts";
import { append, allEntries } from "../src/ledger/ledger.ts";
import {
  computeBurn,
  readClock,
  reconcileLifecycle,
  formatDeathDate,
  DAY_MS,
  DEFAULT_CLOCK_CONFIG,
  type ClockConfig,
} from "../src/deathclock.ts";
import { getState } from "../src/db.ts";

const CFG: ClockConfig = { windowDays: 7, floorMicrosPerDay: 250_000 };
const T0 = new Date("2026-09-15T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY_MS);

/**
 * The published number. If the burn is understated, `dies_at` is overstated and
 * the site is telling people it has longer to live than it does — the one
 * direction this project must never be wrong in. Several of these tests assert
 * that specific asymmetry rather than just "the maths runs".
 */
describe("computeBurn", () => {
  it("divides by the history that exists, not by the whole window", () => {
    // $3 spent over three days is $1/day, not $3/7.
    const b = computeBurn(3_000_000, at(-3).toISOString(), T0, CFG);
    expect(b.daysObserved).toBeCloseTo(3, 5);
    expect(b.observed).toBe(1_000_000);
  });

  it("never divides by less than one day, so a first-hour spend is not annualised", () => {
    const b = computeBurn(500_000, at(-1 / 24).toISOString(), T0, CFG);
    expect(b.daysObserved).toBe(1);
    expect(b.observed).toBe(500_000);
  });

  it("caps the divisor at the window, so old history cannot dilute recent burn", () => {
    const b = computeBurn(7_000_000, at(-90).toISOString(), T0, CFG);
    expect(b.daysObserved).toBe(7);
    expect(b.observed).toBe(1_000_000);
  });

  it("applies the floor and says so when it does", () => {
    const b = computeBurn(0, at(-7).toISOString(), T0, CFG);
    expect(b.observed).toBe(0);
    expect(b.effective).toBe(250_000);
    expect(b.floored).toBe(true);
  });

  it("does not claim to be floored when observed burn is above the floor", () => {
    const b = computeBurn(7_000_000, at(-7).toISOString(), T0, CFG);
    expect(b.effective).toBe(b.observed);
    expect(b.floored).toBe(false);
  });

  it("treats an empty ledger as one day of history rather than dividing by zero", () => {
    const b = computeBurn(0, null, T0, CFG);
    expect(b.daysObserved).toBe(1);
    expect(Number.isFinite(b.observed)).toBe(true);
  });
});

describe("readClock", () => {
  it("computes balance, days left and the death date from the ledger alone", async () => {
    const db = await freshDb();
    await append(db, {
      direction: "in",
      amount_micros: 10_000_000,
      kind: "startup_capital",
      description: "seed",
      ts: at(-2).toISOString(),
    });
    await append(db, {
      direction: "out",
      amount_micros: 2_000_000,
      kind: "inference",
      description: "two days of thinking",
      ts: at(-1).toISOString(),
    });

    const clock = await readClock(db, CFG, T0);
    expect(clock.balance_micros).toBe(8_000_000);
    expect(clock.total_in_micros).toBe(10_000_000);
    expect(clock.total_out_micros).toBe(2_000_000);
    expect(clock.alive).toBe(true);
    // $8 left at $1/day observed over two days.
    expect(clock.burn_micros_per_day).toBe(1_000_000);
    expect(clock.days_left).toBe(8);
    expect(Date.parse(clock.dies_at!)).toBe(T0.getTime() + 8 * DAY_MS);
  });

  it("is dead at exactly zero, not merely below it", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in", ts: T0.toISOString() });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out", ts: T0.toISOString() });

    const clock = await readClock(db, CFG, T0);
    expect(clock.balance_micros).toBe(0);
    expect(clock.alive).toBe(false);
    expect(clock.days_left).toBeNull();
    expect(clock.dies_at).toBeNull();
  });

  it("excludes zero-amount markers from the balance by construction", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000_000, kind: "donation", description: "real", ts: T0.toISOString() });
    await append(db, {
      direction: "in",
      amount_micros: 0,
      kind: "alms_offer",
      description: "an unverified offer",
      metadata: { offered_micros: 10_000, settled: false },
      ts: T0.toISOString(),
    });

    const clock = await readClock(db, CFG, T0);
    expect(clock.balance_micros).toBe(1_000_000);
  });
});

describe("reconcileLifecycle", () => {
  it("writes a death marker once and then stays quiet", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in", ts: T0.toISOString() });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out", ts: T0.toISOString() });

    const first = await reconcileLifecycle(db, T0);
    expect(first.changed).toBe("died");
    expect(await getState(db, "alive")).toBe("false");

    const second = await reconcileLifecycle(db, T0);
    const third = await reconcileLifecycle(db, T0);
    expect(second.changed).toBeNull();
    expect(third.changed).toBeNull();

    const deaths = (await allEntries(db)).filter((e) => e.kind === "death");
    expect(deaths).toHaveLength(1);
    expect(deaths[0]!.amount_micros).toBe(0);
  });

  it("resurrects on new money and counts how many times", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in", ts: T0.toISOString() });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out", ts: T0.toISOString() });
    await reconcileLifecycle(db, T0);

    await append(db, { direction: "in", amount_micros: 5_000, kind: "donation", description: "rescue", ts: at(0.5).toISOString() });
    const back = await reconcileLifecycle(db, at(0.5));

    expect(back.changed).toBe("resurrected");
    expect(back.resurrections).toBe(1);
    expect((await readClock(db, CFG, at(0.5))).resurrections).toBe(1);

    const markers = (await allEntries(db)).filter((e) => e.kind === "resurrection");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.metadata["resurrection_number"]).toBe(1);
  });

  it("survives a full death / resurrection / death cycle with the chain intact", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in", ts: T0.toISOString() });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out", ts: T0.toISOString() });
    await reconcileLifecycle(db, T0);
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "again", ts: at(1).toISOString() });
    await reconcileLifecycle(db, at(1));
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "spent", ts: at(2).toISOString() });
    await reconcileLifecycle(db, at(2));

    const entries = await allEntries(db);
    expect(entries.filter((e) => e.kind === "death")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "resurrection")).toHaveLength(1);
    expect(entries[entries.length - 1]!.metadata["lifetime_number"]).toBe(2);
  });

  it("does nothing on a healthy ledger", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 5_000_000, kind: "startup_capital", description: "seed" });
    expect((await reconcileLifecycle(db)).changed).toBeNull();
    expect((await allEntries(db)).filter((e) => e.amount_micros === 0)).toHaveLength(0);
  });
});

describe("formatDeathDate", () => {
  it("switches to hours inside a day and never shows a negative countdown", () => {
    expect(formatDeathDate(at(0.25).toISOString(), T0)).toBe("in 6 hours");
    expect(formatDeathDate(at(-5).toISOString(), T0)).toBe("within the hour");
  });

  it("names the day for anything further out", () => {
    // 2026-09-18 is a Friday. The month abbreviation is left loose because ICU
    // renders en-GB September as "Sep" or "Sept" depending on the build.
    expect(formatDeathDate(at(3).toISOString(), T0)).toMatch(/^Fri 18 Sept?$/);
  });

  it("has an answer for a ledger with no spending at all", () => {
    expect(formatDeathDate(null, T0)).toBe("never, apparently");
    expect(formatDeathDate(at(400).toISOString(), T0)).toBe("not this year");
  });
});

describe("default config", () => {
  it("matches the documented floor and window", () => {
    expect(DEFAULT_CLOCK_CONFIG).toEqual({ windowDays: 7, floorMicrosPerDay: 250_000 });
  });
});
