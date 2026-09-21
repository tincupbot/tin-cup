import { describe, expect, it } from "vitest";
import { freshDb } from "./helpers.ts";
import { handleKofi, KOFI_TEST_TRANSACTION_ID, type KofiPayload } from "../src/kofi.ts";
import { lastDeliveryAt, outcomeOf, recentDeliveries, recordDelivery } from "../src/webhooklog.ts";

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

/** The route's own sequence, so the test exercises the mapping that ships. */
async function deliver(
  db: Awaited<ReturnType<typeof freshDb>>,
  p: KofiPayload | null,
  token: string | undefined = TOKEN,
  opts: { dryRun?: boolean } = {},
) {
  const result = await handleKofi(db, p, token, new Date(), opts);
  const { outcome, reason, ledgerId } = outcomeOf(result);
  const httpStatus = result.status === "rejected" ? result.httpStatus : 200;
  await recordDelivery(db, { source: "ko-fi", outcome, reason, httpStatus, payload: p, ledgerId });
  return result;
}

describe("the delivery log", () => {
  it("records a booked donation and joins it to the ledger entry", async () => {
    const db = await freshDb();
    const res = await deliver(db, payload());
    if (res.status !== "ok" || res.duplicate) throw new Error("expected a fresh entry");

    const [row] = await recentDeliveries(db);
    expect(row).toMatchObject({
      source: "ko-fi",
      outcome: "booked",
      http_status: 200,
      amount_micros: 3_000_000,
      currency: "USD",
      event_type: "Donation",
      ledger_id: res.entry.id,
    });
  });

  it("records the outcomes that never become money, which is the whole point", async () => {
    const db = await freshDb();

    await deliver(db, payload({ kofi_transaction_id: KOFI_TEST_TRANSACTION_ID, message_id: "m-test" }));
    await deliver(db, payload({ message_id: "m-dry" }), TOKEN, { dryRun: true });
    await deliver(db, payload({ message_id: "m-bad" }), "a-different-token");
    await deliver(db, payload({ message_id: "m-eur", currency: "EUR" }));
    await deliver(db, null);

    const rows = await recentDeliveries(db);
    expect(rows.map((r) => [r.outcome, r.http_status])).toEqual([
      ["rejected", 400], // unparseable body
      ["rejected", 400], // unsupported currency EUR
      ["rejected", 401], // bad verification token
      ["dry_run", 200],
      ["test_payment", 200],
    ]);

    // Every one of those left the books alone; the log is the only trace, and
    // it exists. That is the property this table was added for.
    expect(rows.every((r) => r.ledger_id === null)).toBe(true);
  });

  it("keeps what the payload claimed even when the claim was refused", async () => {
    const db = await freshDb();
    await deliver(db, payload({ currency: "EUR", amount: "5.00" }));

    const [row] = await recentDeliveries(db);
    // Wrong currency, so nothing was credited — but the amount and the currency
    // are exactly the facts the operator needs to see to know what Ko-fi sends.
    expect(row).toMatchObject({ outcome: "rejected", amount_micros: 5_000_000, currency: "EUR" });
  });

  it("never stores the verification token, the supporter's name or their message", async () => {
    const db = await freshDb();
    await deliver(db, payload({ from_name: "Mallory", message: "a private note" }));
    await deliver(db, payload({ message_id: "m2" }), "wrong-token-entirely");

    const dump = JSON.stringify(await recentDeliveries(db));
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("wrong-token-entirely");
    expect(dump).not.toContain("Mallory");
    expect(dump).not.toContain("a private note");
  });

  it("survives a payload too broken to have an amount", async () => {
    const db = await freshDb();
    await deliver(db, payload({ amount: "not a number" }));
    const rows = await recentDeliveries(db);
    // NULL rather than 0: we do not know what was claimed, and a zero would say
    // we did.
    expect(rows[0]).toMatchObject({ amount_micros: null, outcome: "rejected" });
  });

  it("answers 'has the webhook ever fired?' with null until it has", async () => {
    const db = await freshDb();
    expect(await lastDeliveryAt(db, "ko-fi")).toBeNull();
    await deliver(db, payload());
    expect(await lastDeliveryAt(db, "ko-fi")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A different source is a different question.
    expect(await lastDeliveryAt(db, "x402")).toBeNull();
  });

  it("records a retry as a duplicate rather than losing it", async () => {
    const db = await freshDb();
    await deliver(db, payload());
    await deliver(db, payload());

    const rows = await recentDeliveries(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(["duplicate", "booked"]);
    // Both point at the same single ledger entry. Two knocks, one line of money.
    expect(new Set(rows.map((r) => r.ledger_id)).size).toBe(1);
  });
});
