import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.ts";
import { handleKofi, parseKofiBody, KOFI_TEST_TRANSACTION_ID, type KofiPayload } from "../src/kofi.ts";
import { readClock, reconcileLifecycle } from "../src/deathclock.ts";
import { allEntries, append } from "../src/ledger/ledger.ts";
import { wallFrom } from "../src/patrons.ts";

const TOKEN = "correct-horse-battery-staple";

function payload(over: Partial<KofiPayload> = {}): KofiPayload {
  return {
    verification_token: TOKEN,
    message_id: "msg-1",
    type: "Donation",
    is_public: true,
    from_name: "A Stranger",
    message: "good luck",
    amount: "3.00",
    currency: "USD",
    kofi_transaction_id: "tx-1",
    ...over,
  };
}

describe("parseKofiBody", () => {
  it("reads the JSON out of the `data` form field", () => {
    const form = new URLSearchParams({ data: JSON.stringify({ message_id: "m" }) });
    expect(parseKofiBody(form)).toMatchObject({ message_id: "m" });
  });

  it("returns null for a missing, unparseable or non-object body", () => {
    expect(parseKofiBody(new URLSearchParams())).toBeNull();
    expect(parseKofiBody(new URLSearchParams({ data: "{" }))).toBeNull();
    expect(parseKofiBody(new URLSearchParams({ data: '"a string"' }))).toBeNull();
  });
});

describe("handleKofi", () => {
  it("credits a valid donation and puts the donor on the wall", async () => {
    const db = await freshDb();
    const res = await handleKofi(db, payload(), TOKEN);

    expect(res.status).toBe("ok");
    if (res.status !== "ok" || res.duplicate) throw new Error("expected a fresh entry");
    expect(res.entry.amount_micros).toBe(3_000_000);
    expect((await readClock(db)).balance_micros).toBe(3_000_000);

    const wall = wallFrom(await allEntries(db));
    expect(wall.named).toHaveLength(1);
    expect(wall.named[0]).toMatchObject({ name: "A Stranger", total_micros: 3_000_000 });
  });

  it("stores whether there was a message, never the message itself", async () => {
    const db = await freshDb();
    const res = await handleKofi(db, payload({ message: "please read my startup idea" }), TOKEN);
    if (res.status !== "ok" || res.duplicate) throw new Error("expected a fresh entry");

    const serialised = JSON.stringify(res.entry.metadata);
    expect(res.entry.metadata["had_message"]).toBe(true);
    expect(serialised).not.toContain("startup idea");
  });

  it("keeps a private donor off the wall but still counts the money", async () => {
    const db = await freshDb();
    await handleKofi(db, payload({ is_public: false }), TOKEN);

    const wall = wallFrom(await allEntries(db));
    expect(wall.named).toHaveLength(0);
    expect(wall.anonymous).toEqual({ count: 1, total_micros: 3_000_000 });
  });

  it("refuses a bad token, and refuses everything when no token is configured", async () => {
    const db = await freshDb();
    expect(await handleKofi(db, payload({ verification_token: "wrong" }), TOKEN)).toMatchObject({
      status: "rejected",
      httpStatus: 401,
    });
    expect(await handleKofi(db, payload(), undefined)).toMatchObject({ status: "rejected", httpStatus: 503 });
    expect(await allEntries(db)).toHaveLength(0);
  });

  it("refuses a bad amount or a currency it cannot honestly convert", async () => {
    const db = await freshDb();
    for (const over of [{ amount: "0" }, { amount: "-5" }, { amount: "banana" }, { currency: "EUR" }]) {
      expect(await handleKofi(db, payload(over), TOKEN), JSON.stringify(over)).toMatchObject({ status: "rejected" });
    }
    expect(await allEntries(db)).toHaveLength(0);
  });

  it("does not double-credit a retried delivery", async () => {
    const db = await freshDb();
    const first = await handleKofi(db, payload(), TOKEN);
    const second = await handleKofi(db, payload(), TOKEN);

    if (first.status !== "ok" || first.duplicate) throw new Error("expected a fresh entry");
    expect(second).toMatchObject({ status: "ok", duplicate: true, ledgerId: first.entry.id });
    expect((await readClock(db)).balance_micros).toBe(3_000_000);
    expect((await allEntries(db)).filter((e) => e.kind === "donation")).toHaveLength(1);
  });

  it("does not double-credit two concurrent deliveries of the same id", async () => {
    // The race the old check-then-insert ordering allowed: both callers pass the
    // existence check before either writes, and the money lands twice — in a
    // ledger with no delete path, so it stays landed twice.
    const db = await freshDb();
    const results = await Promise.all([
      handleKofi(db, payload(), TOKEN),
      handleKofi(db, payload(), TOKEN),
      handleKofi(db, payload(), TOKEN),
    ]);

    const fresh = results.filter((r) => r.status === "ok" && !r.duplicate);
    const dupes = results.filter((r) => r.status === "ok" && r.duplicate);
    expect(fresh).toHaveLength(1);
    expect(dupes).toHaveLength(2);
    expect((await readClock(db)).balance_micros).toBe(3_000_000);
  });

  it("still accepts a corrected redelivery after rejecting a broken one", async () => {
    // A rejected payload must not burn the message id, or a Ko-fi retry that
    // fixes the problem would be silently swallowed as a duplicate.
    const db = await freshDb();
    expect(await handleKofi(db, payload({ amount: "banana" }), TOKEN)).toMatchObject({ status: "rejected" });

    const retry = await handleKofi(db, payload(), TOKEN);
    expect(retry).toMatchObject({ status: "ok", duplicate: false });
    expect((await readClock(db)).balance_micros).toBe(3_000_000);
  });

  it("brings a dead agent back when money arrives", async () => {
    const db = await freshDb();
    await append(db, { direction: "in", amount_micros: 1_000, kind: "donation", description: "in" });
    await append(db, { direction: "out", amount_micros: 1_000, kind: "inference", description: "out" });
    // The death has to be *recorded* before there is anything to come back from.
    expect((await reconcileLifecycle(db)).changed).toBe("died");

    await handleKofi(db, payload({ message_id: "rescue" }), TOKEN);

    const clock = await readClock(db);
    expect(clock.alive).toBe(true);
    expect(clock.resurrections).toBe(1);
  });
});

/**
 * Money that nobody was charged.
 *
 * Both paths below produce a verified, well-formed, entirely genuine Ko-fi
 * delivery that must never become a ledger entry — and the ledger has no delete
 * path, so "must never" is literal.
 */
describe("deliveries that are verified but must not be booked", () => {
  it("acknowledges Ko-fi's own test payment without writing anything", async () => {
    const db = await freshDb();

    const res = await handleKofi(db, payload({ kofi_transaction_id: KOFI_TEST_TRANSACTION_ID }), TOKEN);

    expect(res).toMatchObject({ status: "observed", reason: "ko-fi test payment", currency: "USD" });
    expect(await allEntries(db)).toHaveLength(0);
  });

  it("catches the test payment by its url when the transaction id is not the tell", async () => {
    const db = await freshDb();

    const res = await handleKofi(
      db,
      payload({
        kofi_transaction_id: "something-else",
        url: `https://ko-fi.com/Home/CoffeeShop?txid=${KOFI_TEST_TRANSACTION_ID}`,
      }),
      TOKEN,
    );

    expect(res).toMatchObject({ status: "observed", reason: "ko-fi test payment" });
    expect(await allEntries(db)).toHaveLength(0);
  });

  it("reports what a dry run would have credited, and credits nothing", async () => {
    const db = await freshDb();

    const res = await handleKofi(db, payload({ amount: "5.00" }), TOKEN, new Date(), { dryRun: true });

    expect(res).toMatchObject({
      status: "observed",
      reason: "dry run",
      amountMicros: 5_000_000,
      currency: "USD",
      kofiType: "Donation",
    });
    expect(await allEntries(db)).toHaveLength(0);
  });

  it("does not burn the message id, so the real delivery still lands", async () => {
    // A dry run that claimed the id would make the donation that follows look
    // like a duplicate and silently vanish.
    const db = await freshDb();

    await handleKofi(db, payload(), TOKEN, new Date(), { dryRun: true });
    const real = await handleKofi(db, payload(), TOKEN);

    expect(real).toMatchObject({ status: "ok", duplicate: false });
    expect(await allEntries(db)).toHaveLength(1);
  });

  it("still refuses a bad token and a bad currency while dry running", async () => {
    const db = await freshDb();
    const dry = { dryRun: true };

    expect(await handleKofi(db, payload({ verification_token: "wrong" }), TOKEN, new Date(), dry)).toMatchObject({
      status: "rejected",
      httpStatus: 401,
    });
    expect(await handleKofi(db, payload({ currency: "EUR" }), TOKEN, new Date(), dry)).toMatchObject({
      status: "rejected",
      reason: "unsupported currency EUR",
    });
  });
});
