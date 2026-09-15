import { describe, expect, it } from "vitest";
import { formatUsd, formatUsdPrecise, formatRate, usdToMicros, tokenCostMicros, MICROS_PER_USD } from "../src/money.ts";

/**
 * Formatting is the last millimetre, where integers become something a human
 * reads. It is also where a ledger can quietly start lying: a cost of 412 micros
 * printed as "$0.00" makes a page of real spending look like a page of nothing.
 */
describe("formatUsd", () => {
  it("renders whole and fractional dollars to the cent", () => {
    expect(formatUsd(4_120_000)).toBe("$4.12");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(50_000)).toBe("$0.05");
  });

  it("groups thousands", () => {
    expect(formatUsd(1_234_567_000_000)).toBe("$1,234,567.00");
  });

  it("rounds to the nearest cent rather than truncating", () => {
    expect(formatUsd(5_999)).toBe("$0.01");
    expect(formatUsd(4_999)).toBe("$0.00");
  });

  it("keeps the minus sign outside the dollar sign", () => {
    expect(formatUsd(-2_500_000)).toBe("-$2.50");
  });
});

describe("formatUsdPrecise", () => {
  it("shows sub-cent amounts instead of rounding them into nothing", () => {
    expect(formatUsdPrecise(412)).toBe("$0.000412");
    expect(formatUsdPrecise(5)).toBe("$0.000005");
  });

  it("trims trailing zeroes but never below two decimal places", () => {
    expect(formatUsdPrecise(1_000_000)).toBe("$1.00");
    expect(formatUsdPrecise(1_500_000)).toBe("$1.50");
    expect(formatUsdPrecise(1_230_000)).toBe("$1.23");
    expect(formatUsdPrecise(0)).toBe("$0.00");
  });

  it("handles amounts above a dollar with a sub-cent tail", () => {
    expect(formatUsdPrecise(1_000_412)).toBe("$1.000412");
  });
});

describe("formatRate", () => {
  it("reads as a per-day rate", () => {
    expect(formatRate(710_000)).toBe("$0.71/day");
  });
});

describe("conversions", () => {
  it("round-trips dollars through micros", () => {
    expect(usdToMicros(3)).toBe(3_000_000);
    expect(usdToMicros(0.01)).toBe(10_000);
    expect(MICROS_PER_USD).toBe(1_000_000);
  });

  it("rounds a float donation amount to the nearest micro rather than drifting", () => {
    // 0.1 + 0.2 arithmetic has no place in a ledger; this is where it is stopped.
    expect(usdToMicros(0.1 + 0.2)).toBe(300_000);
    expect(Number.isInteger(usdToMicros(1.005))).toBe(true);
  });

  it("rounds token costs up, so the books never understate what was spent", () => {
    expect(tokenCostMicros(1, 1_000_000)).toBe(1);
    expect(tokenCostMicros(1, 5_000_000)).toBe(5);
    // A third of a micro still costs a micro. Erring downward would let a
    // thousand tiny calls vanish from the burn rate.
    expect(tokenCostMicros(1, 300_000)).toBe(1);
    expect(tokenCostMicros(0, 5_000_000)).toBe(0);
  });
});
