import type { Db } from "./db.ts";
import { getState, setState } from "./db.ts";
import { append } from "./ledger/ledger.ts";

export const DAY_MS = 86_400_000;

export type ClockConfig = {
  /** Trailing window for the burn-rate average, in days. */
  windowDays: number;
  /**
   * Minimum burn used in the dies_at calculation.
   *
   * A floor is not fudging the number — it stops `dies_at` running to infinity on
   * a quiet day, which would render the clock as "dies never" and make the whole
   * premise a lie in the other direction. The *observed* burn is always reported
   * alongside it so the floor is visible rather than hidden.
   */
  floorMicrosPerDay: number;
};

export const DEFAULT_CLOCK_CONFIG: ClockConfig = {
  windowDays: 7,
  floorMicrosPerDay: 250_000, // $0.25/day
};

export type Clock = {
  balance_micros: number;
  total_in_micros: number;
  total_out_micros: number;
  /** What it actually spent per day over the window. Can be 0. */
  observed_burn_micros_per_day: number;
  /** The number used for dies_at: max(observed, floor). */
  burn_micros_per_day: number;
  burn_is_floored: boolean;
  days_observed: number;
  days_left: number | null;
  dies_at: string | null;
  alive: boolean;
  died_at: string | null;
  resurrections: number;
  first_entry_at: string | null;
  now: string;
};

type Sums = { total_in: number; total_out: number; window_out: number; first_ts: string | null };

async function sums(db: Db, now: Date, windowDays: number): Promise<Sums> {
  const windowStart = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount_micros ELSE 0 END), 0) AS total_in,
         COALESCE(SUM(CASE WHEN direction = 'out' THEN amount_micros ELSE 0 END), 0) AS total_out,
         COALESCE(SUM(CASE WHEN direction = 'out' AND ts >= ? THEN amount_micros ELSE 0 END), 0) AS window_out,
         MIN(ts) AS first_ts
       FROM ledger`,
    )
    .bind(windowStart)
    .first<Sums>();
  return row ?? { total_in: 0, total_out: 0, window_out: 0, first_ts: null };
}

/**
 * Burn = trailing average of spending over the window.
 *
 * The divisor is the number of days of history that actually exist, capped at the
 * window. With three days of history you get a three-day average, not a seven-day
 * average with four zeroes dragging it down — that would understate burn and
 * overstate life expectancy, which is the direction we must never err in.
 */
export function computeBurn(
  windowOutMicros: number,
  firstEntryAt: string | null,
  now: Date,
  cfg: ClockConfig,
): { observed: number; effective: number; floored: boolean; daysObserved: number } {
  let daysObserved = cfg.windowDays;
  if (firstEntryAt) {
    const elapsed = (now.getTime() - Date.parse(firstEntryAt)) / DAY_MS;
    daysObserved = Math.min(cfg.windowDays, Math.max(1, elapsed));
  } else {
    daysObserved = 1;
  }
  const observed = Math.round(windowOutMicros / daysObserved);
  const effective = Math.max(observed, cfg.floorMicrosPerDay);
  return { observed, effective, floored: effective !== observed, daysObserved };
}

export async function readClock(
  db: Db,
  cfg: ClockConfig = DEFAULT_CLOCK_CONFIG,
  now: Date = new Date(),
): Promise<Clock> {
  const s = await sums(db, now, cfg.windowDays);
  const balance = s.total_in - s.total_out;
  const burn = computeBurn(s.window_out, s.first_ts, now, cfg);

  const alive = balance > 0;
  const daysLeft = alive ? balance / burn.effective : null;
  const diesAt = daysLeft === null ? null : new Date(now.getTime() + daysLeft * DAY_MS).toISOString();

  const resurrections = Number(await getState(db, "resurrections")) || 0;
  const diedAt = await getState(db, "died_at");

  return {
    balance_micros: balance,
    total_in_micros: s.total_in,
    total_out_micros: s.total_out,
    observed_burn_micros_per_day: burn.observed,
    burn_micros_per_day: burn.effective,
    burn_is_floored: burn.floored,
    days_observed: Math.round(burn.daysObserved * 100) / 100,
    days_left: daysLeft === null ? null : Math.round(daysLeft * 100) / 100,
    dies_at: diesAt,
    alive,
    died_at: alive ? null : diedAt,
    resurrections,
    first_entry_at: s.first_ts,
    now: now.toISOString(),
  };
}

export type LifecycleChange = { changed: "died" | "resurrected" | null; resurrections: number };

/**
 * Reconcile the recorded alive/dead state with what the balance actually says,
 * and write the transition to the ledger as its own event.
 *
 * Called after every append and at the top of the scheduled run. Idempotent:
 * if the state already matches the balance, nothing is written.
 */
export async function reconcileLifecycle(db: Db, now: Date = new Date()): Promise<LifecycleChange> {
  const clock = await readClock(db, DEFAULT_CLOCK_CONFIG, now);
  const recordedAlive = (await getState(db, "alive")) !== "false";
  const resurrections = Number(await getState(db, "resurrections")) || 0;
  const ts = now.toISOString();

  if (!clock.alive && recordedAlive) {
    // It had money and now it doesn't. This is the whole point of the project.
    await append(db, {
      direction: "in",
      amount_micros: 0,
      kind: "death",
      description: "Out of money. Inference stopped.",
      metadata: {
        event: "death",
        final_balance_micros: clock.balance_micros,
        total_in_micros: clock.total_in_micros,
        total_out_micros: clock.total_out_micros,
        lifetime_number: resurrections + 1,
      },
      ts,
    });
    await setState(db, "alive", "false");
    await setState(db, "died_at", ts);
    return { changed: "died", resurrections };
  }

  if (clock.alive && !recordedAlive) {
    const n = resurrections + 1;
    const diedAt = await getState(db, "died_at");
    await append(db, {
      direction: "in",
      amount_micros: 0,
      kind: "resurrection",
      description: n === 1 ? "Someone put money in the cup. Back." : `Back again. Resurrection number ${n}.`,
      metadata: {
        event: "resurrection",
        resurrection_number: n,
        died_at: diedAt,
        balance_micros_on_return: clock.balance_micros,
        dead_for_seconds: diedAt ? Math.round((now.getTime() - Date.parse(diedAt)) / 1000) : null,
      },
      ts,
    });
    await setState(db, "alive", "true");
    await setState(db, "resurrections", String(n));
    await setState(db, "died_at", "");
    return { changed: "resurrected", resurrections: n };
  }

  return { changed: null, resurrections };
}

/** Thrown by any inference path when the balance is gone. */
export class AgentIsDeadError extends Error {
  constructor() {
    super("dead");
    this.name = "AgentIsDeadError";
  }
}

/** "Thu 18 Sep". Deliberately short — it belongs in a headline, not a table. */
export function formatDeathDate(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never, apparently";
  const d = new Date(iso);
  const diffDays = (d.getTime() - now.getTime()) / DAY_MS;
  if (diffDays < 1) {
    const hours = Math.max(0, Math.round((d.getTime() - now.getTime()) / 3_600_000));
    return hours <= 1 ? "within the hour" : `in ${hours} hours`;
  }
  if (diffDays > 365) return "not this year";
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
