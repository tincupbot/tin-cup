import { describe, expect, it } from "vitest";
import { freshDb, testEnv } from "./helpers.ts";
import { app } from "../src/index.ts";
import { append } from "../src/ledger/ledger.ts";
import { summary } from "../src/passersby/counter.ts";
import { PORTRAIT_PNG, ICON_PNG } from "../src/assets/serve.ts";
import { PORTRAIT_PATH, ICON_PATH } from "../src/assets/paths.ts";
import { PORTRAIT_ALT } from "../src/copy.ts";

/**
 * The only two non-text responses this site makes.
 *
 * They are carried in the bundle as base64, which is a real decision with a
 * real failure mode: a truncated or mis-encoded blob still serves a 200 and a
 * plausible content-type, and the only thing that catches it is checking the
 * bytes. So these tests read the magic number rather than the status line.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";

describe("the embedded images", () => {
  it("serves a real PNG at each path", async () => {
    const env = testEnv(await freshDb());

    for (const [path, img] of [
      [PORTRAIT_PATH, PORTRAIT_PNG],
      [ICON_PATH, ICON_PNG],
    ] as const) {
      const res = await app.fetch(new Request(`https://tincup.test${path}`), env);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe("image/png");
      expect(res.headers.get("etag"), path).toBe(img.etag);

      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length, path).toBe(img.bytes);
      expect([...body.slice(0, 8)], path).toEqual(PNG_MAGIC);
    }
  });

  it("answers a matching If-None-Match with 304 and no body", async () => {
    const env = testEnv(await freshDb());

    const res = await app.fetch(
      new Request(`https://tincup.test${PORTRAIT_PATH}`, {
        headers: { "if-none-match": PORTRAIT_PNG.etag },
      }),
      env,
    );

    expect(res.status).toBe(304);
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 0);
    expect(res.headers.get("etag")).toBe(PORTRAIT_PNG.etag);
  });

  it("re-sends the body when the etag does not match", async () => {
    const env = testEnv(await freshDb());

    const res = await app.fetch(
      new Request(`https://tincup.test${PORTRAIT_PATH}`, {
        headers: { "if-none-match": '"stale"' },
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(PORTRAIT_PNG.bytes);
  });

  it("does not count an image fetch as a passer-by", async () => {
    // One crawler reading the homepage and its portrait is one visit, not two.
    // The crowd numbers are the product here; inflating them with asset
    // requests is the same bug as calling 23 requests 23 agents.
    const db = await freshDb();
    const env = testEnv(db);

    const headers = { "user-agent": GPTBOT };
    await app.fetch(new Request("https://tincup.test/", { headers }), env);
    const after = await summary(db);

    await app.fetch(new Request(`https://tincup.test${PORTRAIT_PATH}`, { headers }), env);
    await app.fetch(new Request(`https://tincup.test${ICON_PATH}`, { headers }), env);

    expect(await summary(db)).toEqual(after);
  });
});

describe("the portrait on the page", () => {
  it("hangs in the banner with alt text that says drawing, not photograph", async () => {
    // Funded on purpose: a broke Tin Cup renders the gravestone, and the
    // banner the portrait hangs in never appears.
    const db = await freshDb();
    await append(db, {
      direction: "in",
      amount_micros: 5_000_000,
      kind: "startup_capital",
      description: "test float",
      ts: new Date().toISOString(),
    });
    const env = testEnv(db);

    const html = await (await app.fetch(new Request("https://tincup.test/"), env)).text();

    expect(html).toContain(`src="${PORTRAIT_PATH}"`);
    expect(html).toContain("cartoon busker");
    expect(PORTRAIT_ALT).toMatch(/cartoon/i);
    expect(html).not.toContain("no photograph");
  });

  it("gives link previews an absolute image URL and no double slash", async () => {
    const db = await freshDb();

    for (const site of ["https://tincup.test", "https://tincup.test/"]) {
      const html = await (
        await app.fetch(new Request("https://tincup.test/"), testEnv(db, { SITE_URL: site }))
      ).text();
      expect(html, site).toContain('<meta property="og:image" content="https://tincup.test/portrait.png">');
    }
  });

  it("points the favicon at the icon", async () => {
    const env = testEnv(await freshDb());

    const html = await (await app.fetch(new Request("https://tincup.test/"), env)).text();

    expect(html).toContain(`<link rel="icon" type="image/png" href="${ICON_PATH}">`);
    expect(html).not.toContain("data:image/svg+xml");
  });

  it("allows same-origin images in the CSP and nothing third-party", async () => {
    const env = testEnv(await freshDb());

    const res = await app.fetch(new Request("https://tincup.test/"), env);
    const csp = res.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
  });
});
