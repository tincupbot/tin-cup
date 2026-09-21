import type { Db } from "./db.ts";
import { append, type LedgerEntry } from "./ledger/ledger.ts";
import { usdToMicros } from "./money.ts";
import { reconcileLifecycle } from "./deathclock.ts";

/**
 * Ko-fi webhook handling.
 *
 * Ko-fi POSTs `application/x-www-form-urlencoded` with a single field `data`
 * containing a JSON string. Shape below is from their documented payload. This
 * module never contacts Ko-fi — verification is a shared token they include in
 * the payload itself, compared against one we hold as a secret.
 *
 * ---------------------------------------------------------------------------
 * FEES, AND WHY THIS CREDITS THE GROSS
 * ---------------------------------------------------------------------------
 *
 * Ko-fi takes a platform cut and the card processor takes another, so less
 * money arrives than the donor sent. A ledger whose entire claim is that its
 * numbers are real has to have an answer for that gap.
 *
 * Checked 2026-09-21: THE WEBHOOK PAYLOAD CARRIES NO FEE AND NO NET FIELD.
 * The documented fields are verification_token, message_id, timestamp, type,
 * is_public, from_name, message, amount, url, email, currency,
 * is_subscription_payment, is_first_subscription_payment, kofi_transaction_id,
 * tier_name, shop_items, shipping. `amount` is the gross the supporter typed.
 * Ko-fi publishes no REST API to ask afterwards either; the webhook is the
 * entire developer surface. (Their own help page is behind a bot check; this
 * was confirmed against three independent published descriptions of the
 * payload, and the absence is consistent across all of them.)
 *
 * That leaves exactly two options, and only one of them is allowed here:
 *
 *   (a) Compute a net by subtracting assumed rates. Rejected. It would put a
 *       number in the books that nobody has been charged and nobody can check,
 *       in the one place where being approximately right is worse than being
 *       late — and the assumed rate is itself contested: Ko-fi's features page
 *       says most creators pay 5%, while their fee page says 0% on tips.
 *       Guessing between those two and publishing the result as a fact is
 *       precisely the failure this project exists to not commit.
 *
 *   (b) Credit the gross, mark it as gross and unreconciled, and append the
 *       toll later as its own itemised `fee` entry once the payout statement
 *       says what it actually was. Lagging, visible, and true at every point.
 *
 * This is (b). The consequence, stated so nobody is surprised by it: between a
 * donation and its reconciliation the balance is slightly optimistic and the
 * death clock is slightly generous. The homepage says so in `HAT_FEES_NOTE`.
 *
 * THE RECONCILIATION PATH, concretely. There is no automatic one and there
 * must not be — inventing the entry from a rate is option (a) wearing a hat.
 * When the Stripe/PayPal payout lands:
 *
 *   1. Take the real fees for the period from the payout statement.
 *   2. Append one `fee` entry per donation, or one per payout if the statement
 *      only itemises that far, using scripts/operator-entry.ts — the same
 *      hash-chained append path, run out of band. Put the
 *      `kofi_transaction_id`(s) it covers in the metadata so the entry can be
 *      matched back to the donations it corrects.
 *   3. Re-run /ledger/verify. The chain must still be valid.
 *
 * Every donation entry below carries `reconciled: false` so the set still
 * owing a fee entry is a query, not a memory.
 *
 * If Ko-fi ever does start sending a net or fee field, this is the function
 * that changes: credit the net, append the fee as a sibling entry in the same
 * request, and flip `net_reported_by_source`. Until then nothing here guesses.
 */

export type KofiPayload = {
  verification_token?: string;
  message_id?: string;
  timestamp?: string;
  type?: string;
  is_public?: boolean;
  from_name?: string;
  message?: string | null;
  amount?: string;
  currency?: string;
  kofi_transaction_id?: string;
  is_subscription_payment?: boolean;
  is_first_subscription_payment?: boolean;
};

export type KofiResult =
  | { status: "ok"; entry: LedgerEntry; duplicate: false }
  | { status: "ok"; entry: null; duplicate: true; ledgerId: string }
  | { status: "rejected"; reason: string; httpStatus: number };

export function parseKofiBody(form: URLSearchParams): KofiPayload | null {
  const raw = form.get("data");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as KofiPayload) : null;
  } catch {
    return null;
  }
}

/** Constant-time-ish string compare. The token is short; avoid the early exit anyway. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Idempotent on `message_id`. Ko-fi retries, and a retry that double-credits
 * the balance would be a false entry in a ledger whose entire value is that it
 * contains no false entries.
 *
 * ORDER MATTERS HERE, and it is not the obvious order.
 *
 * The obvious version — check `kofi_messages`, append, then record the id — has
 * two failure modes, and both are unfixable after the fact because the ledger
 * has no delete path. Two concurrent retries can both pass the check before
 * either writes, and a crash between the append and the record leaves an entry
 * that the next retry cannot see. Either way the money is counted twice and
 * stays counted twice.
 *
 * So: validate everything first, then *claim* the message id atomically, and
 * only append once the claim is won. Validating before claiming matters too —
 * a rejected payload never takes the id, so a corrected redelivery of the same
 * id is still processed rather than silently swallowed as a duplicate.
 */
export async function handleKofi(
  db: Db,
  payload: KofiPayload | null,
  expectedToken: string | undefined,
  now: Date = new Date(),
): Promise<KofiResult> {
  if (!expectedToken) {
    // Refuse rather than accept unverified money. A donation we can't attribute
    // is worth less than a ledger nobody can trust.
    return { status: "rejected", reason: "no verification token configured", httpStatus: 503 };
  }
  if (!payload) return { status: "rejected", reason: "unparseable body", httpStatus: 400 };
  if (typeof payload.verification_token !== "string" || !tokensMatch(payload.verification_token, expectedToken)) {
    return { status: "rejected", reason: "bad verification token", httpStatus: 401 };
  }
  if (!payload.message_id) return { status: "rejected", reason: "no message_id", httpStatus: 400 };

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { status: "rejected", reason: "bad amount", httpStatus: 400 };
  }
  const currency = (payload.currency ?? "USD").toUpperCase();
  if (currency !== "USD") {
    // The ledger is single-currency on purpose. Converting would mean storing a
    // rate and a date and defending both; refusing is cleaner until it matters.
    return { status: "rejected", reason: `unsupported currency ${currency}`, httpStatus: 400 };
  }

  // Claim the message id. Exactly one caller gets a row back from this; every
  // other concurrent delivery of the same id gets null and is a duplicate.
  const claim = await db
    .prepare(
      `INSERT INTO kofi_messages (message_id, received_at, ledger_id) VALUES (?, ?, '')
       ON CONFLICT(message_id) DO NOTHING
       RETURNING message_id`,
    )
    .bind(payload.message_id, now.toISOString())
    .first<{ message_id: string }>();

  if (!claim) {
    const existing = await db
      .prepare(`SELECT ledger_id FROM kofi_messages WHERE message_id = ?`)
      .bind(payload.message_id)
      .first<{ ledger_id: string }>();
    return { status: "ok", entry: null, duplicate: true, ledgerId: existing?.ledger_id ?? "" };
  }

  // Only public donations get a name on the wall. `is_public` is Ko-fi's own
  // flag for whether the supporter agreed to be shown.
  const name = payload.is_public && payload.from_name ? payload.from_name.trim().slice(0, 48) : "";

  const entry = await append(db, {
    direction: "in",
    amount_micros: usdToMicros(amount),
    kind: "donation",
    // "gross" is in the description, not just the metadata, because the ledger
    // page and the homepage's last-eight table render descriptions and nothing
    // else. Someone reading "+$3.00 · Ko-fi from A Stranger" should not have to
    // open the JSON to learn that ~$2.51 of it is what actually turns up.
    description: name ? `Ko-fi from ${name} · gross, fees not yet reconciled` : "Ko-fi, anonymous · gross, fees not yet reconciled",
    metadata: {
      source: "ko-fi",
      kofi_type: payload.type ?? null,
      message_id: payload.message_id,
      transaction_id: payload.kofi_transaction_id ?? null,
      is_subscription: Boolean(payload.is_subscription_payment),
      // The fee disclosure, in the entry itself rather than only in the page
      // copy — /ledger.json is read by people who will never see the homepage.
      // This is the gross the supporter was charged. Ko-fi's platform cut and
      // the card processor's fee are not in this number and are not yet in the
      // books; see the header of this file for why, and for how they get there.
      amount_is_gross: true,
      net_reported_by_source: false,
      reconciled: false,
      ...(name ? { patron_name: name } : {}),
      // The supporter's message is theirs; we store whether there was one, not
      // what it said. Publishing a stranger's words on a public page by default
      // is not ours to do.
      had_message: Boolean(payload.message),
    },
    ts: now.toISOString(),
  });

  await db
    .prepare(`UPDATE kofi_messages SET ledger_id = ? WHERE message_id = ?`)
    .bind(entry.id, payload.message_id)
    .run();

  // Money arriving may bring it back from the dead.
  await reconcileLifecycle(db, now);

  return { status: "ok", entry, duplicate: false };
}
