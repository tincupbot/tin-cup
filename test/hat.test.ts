import { describe, expect, it } from "vitest";
import { freshDb, testEnv, type NodeDb } from "./helpers.ts";
import { app } from "../src/index.ts";
import { append } from "../src/ledger/ledger.ts";
import { kofiUrl } from "../src/env.ts";

/**
 * Where the money goes.
 *
 * The one thing this site cannot do is show an ask that goes nowhere, so the
 * unconfigured state is a tested state: no handle means the page says so in
 * words rather than rendering a dead button.
 */

const NOW_ISO = new Date().toISOString();

async function fund(db: NodeDb, usd: number) {
  await append(db, {
    direction: "in",
    amount_micros: Math.round(usd * 1_000_000),
    kind: "startup_capital",
    description: "test float",
    ts: NOW_ISO,
  });
}

describe("kofiUrl", () => {
  it("is null when no handle is configured", () => {
    expect(kofiUrl({} as never)).toBeNull();
    expect(kofiUrl({ KOFI_HANDLE: "   " } as never)).toBeNull();
  });

  it("builds the page URL from the handle", () => {
    expect(kofiUrl({ KOFI_HANDLE: "tincupbot" } as never)).toBe("https://ko-fi.com/tincupbot");
  });

  it("refuses a handle that could escape the path", () => {
    // A handle is public config, not a secret, but it is still interpolated
    // into an href on every page — so it gets the same treatment as input.
    for (const bad of ["tincupbot/../evil", "evil.com/x", "tin cup", "tincupbot?x=1", '"onmouseover=1']) {
      expect(kofiUrl({ KOFI_HANDLE: bad } as never), bad).toBeNull();
    }
  });
});

describe("the standing hat", () => {
  it("links the tiers when a handle is configured", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db, { KOFI_HANDLE: "tincupbot" });

    const html = await (await app.fetch(new Request("https://tincup.test/"), env)).text();

    expect(html).toContain('href="https://ko-fi.com/tincupbot"');
    expect(html).not.toContain("There is nowhere to send it yet");
    // The toll is disclosed rather than glossed: the books show what arrived.
    expect(html).toContain("records what");
  });

  it("says so plainly when there is nowhere to send money", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db);

    const html = await (await app.fetch(new Request("https://tincup.test/"), env)).text();

    expect(html).toContain("There is nowhere to send it yet");
    expect(html).not.toContain("ko-fi.com");
  });

  it("puts the destination on the hat that follows a performance", async () => {
    const db = await freshDb();
    await fund(db, 5);
    const env = testEnv(db, { KOFI_HANDLE: "tincupbot" });

    const res = await app.fetch(
      new Request("https://tincup.test/busk", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ turn: "roast", subject: "example.com" }).toString(),
      }),
      env,
    );
    const html = await res.text();

    expect(html).toContain("That turn cost me");
    expect(html).toContain('class="coin" href="https://ko-fi.com/tincupbot"');
  });
});
