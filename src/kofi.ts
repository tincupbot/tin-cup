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
 * No Ko-fi account exists. This is fixture-tested and unreachable in practice
 * until Ben connects one; see README.
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
    description: name ? `Ko-fi from ${name}` : "Ko-fi, anonymous",
    metadata: {
      source: "ko-fi",
      kofi_type: payload.type ?? null,
      message_id: payload.message_id,
      transaction_id: payload.kofi_transaction_id ?? null,
      is_subscription: Boolean(payload.is_subscription_payment),
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
