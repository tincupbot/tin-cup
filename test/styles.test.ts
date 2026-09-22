import { describe, expect, it } from "vitest";
import { STYLES } from "../src/views/styles.ts";

/**
 * Structural checks on the one stylesheet, because CSS fails silently.
 *
 * This file exists because of a real bug that shipped to production. An edit
 * left a stray fragment of prose between a closed comment and the rule under
 * it, so the parser treated the prose plus the following declaration block as
 * one garbage rule and dropped `.banner-in`'s mobile override on the floor.
 * The desktop layout was untouched, every other test passed, typecheck passed,
 * lint passed, and the phone layout silently reverted to a two-column grid that
 * pushed the headline and the entire pitch off the right-hand edge of the
 * screen. Nothing in the suite could see it, because nothing in the suite ever
 * looked at the stylesheet as anything but a string to interpolate.
 *
 * These are deliberately structural rather than visual. They cannot tell you
 * the page looks right — only a browser does that — but they catch the class of
 * mistake that makes a rule vanish without anything appearing to go wrong.
 */

describe("the stylesheet", () => {
  it("has balanced comment delimiters", () => {
    // The exact failure above: one `/*` and two `*/`, which is not a syntax
    // error to a CSS parser — it is a silently different stylesheet.
    const opened = STYLES.match(/\/\*/g)?.length ?? 0;
    const closed = STYLES.match(/\*\//g)?.length ?? 0;

    expect(opened, "every /* needs exactly one */").toBe(closed);
  });

  it("never nests or reopens a comment inside a comment", () => {
    // `/* ... /* ... */` closes at the first `*/` and leaves the tail as live
    // CSS. Same silent-drop failure, opposite direction.
    for (const block of STYLES.match(/\/\*[\s\S]*?\*\//g) ?? []) {
      expect(block.slice(2, -2), "a comment must not contain /*").not.toContain("/*");
    }
  });

  it("has balanced braces", () => {
    const withoutComments = STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = withoutComments.match(/\{/g)?.length ?? 0;
    const close = withoutComments.match(/\}/g)?.length ?? 0;

    expect(open, "every { needs exactly one }").toBe(close);
  });

  it("keeps the phone banner in a single bounded column", () => {
    // The two halves of the full-bleed portrait, asserted by name rather than
    // by effect. A bare `1fr` takes its automatic minimum from the item's
    // min-content, so an image deliberately wider than its track widens the
    // track and the whole banner overflows the viewport. `minmax(0, 1fr)` is
    // what stops that, and it is not obviously load-bearing to someone tidying
    // the file later.
    const mobile = STYLES.slice(STYLES.indexOf("@media (max-width: 34rem)"));

    expect(mobile).toContain("minmax(0, 1fr)");
    expect(mobile, "the portrait goes full bleed on a phone").toContain("calc(100% + 2.2rem)");
  });
});
