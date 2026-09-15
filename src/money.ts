/**
 * Money is integer micro-dollars everywhere. 1 USD = 1_000_000 micros.
 *
 * There are no floats in the ledger, in the balance, or in any arithmetic that
 * touches either. Floats enter only at the last millimetre, when a number is
 * turned into a string for a human to read.
 */

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

/** "$4.12". Rounds to the nearest cent. */
export function formatUsd(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const cents = Math.round(Math.abs(micros) / 10_000);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${sign}$${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
}

/**
 * "$0.000412" — for inference costs, which are routinely smaller than a cent and
 * where rounding to cents would print "$0.00" for everything and make the ledger
 * look like a lie. Trims trailing zeroes down to a minimum of 2 decimal places.
 */
export function formatUsdPrecise(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICROS_PER_USD);
  const frac = String(abs % MICROS_PER_USD).padStart(6, "0").replace(/0+$/, "");
  const padded = frac.length < 2 ? frac.padEnd(2, "0") : frac;
  return `${sign}$${whole.toLocaleString("en-US")}.${padded}`;
}

/** "$0.71/day". */
export function formatRate(microsPerDay: number): string {
  return `${formatUsd(microsPerDay)}/day`;
}

/** Micro-dollars per million tokens -> micro-dollars for n tokens, rounded up. */
export function tokenCostMicros(tokens: number, microsPerMillionTokens: number): number {
  return Math.ceil((tokens * microsPerMillionTokens) / 1_000_000);
}
