import type { X402Config } from "./env.ts";

/**
 * Hand-rolled x402, to the published wire shape.
 *
 * WHY NOT `x402-hono`: I tried it first, as briefed. Three problems, any one of
 * which is disqualifying for this build:
 *
 *  1. It installs 467 packages — `@coinbase/cdp-sdk`, `@solana/kit`, `viem`,
 *     WalletConnect, and a deprecated MetaMask SDK — with 25 advisories, to
 *     serve one joke endpoint.
 *  2. Verification and settlement go through a remote facilitator
 *     (`https://x402.org/facilitator` by default). That is outbound HTTP to a
 *     third party, which this build forbids.
 *  3. It requires a real `payTo` address, validated through viem's `getAddress`.
 *     We do not have one and are not creating one.
 *
 * So: the 402 response below matches the shape `x402-hono` emits — `x402Version: 1`,
 * an `accepts` array of `PaymentRequirements`, the `X-PAYMENT` request header
 * carrying base64 JSON, `X-PAYMENT-RESPONSE` on success. Field names were read
 * off the `x402` package's own zod schemas, not recalled.
 *
 * WHAT IS NOT IN THIS FILE: signature verification, on-chain settlement, and
 * the facilitator round-trip. Those live in `src/facilitator.ts`, against the
 * Coinbase CDP facilitator. Nothing here can tell you whether money moved, and
 * nothing here is permitted to decide that it did.
 *
 * WHAT THAT MEANS FOR THE BOOKS, and this is the load-bearing part. There are
 * two paths through `/alms` and they differ in exactly one thing: whether a
 * facilitator has confirmed a settlement.
 *
 *  - Settlement configured (a real payTo AND facilitator credentials): the
 *    payment is verified, settled, and credited as `x402_alms` with the
 *    transaction hash in metadata as the receipt.
 *  - Otherwise: the payload is recorded as a zero-amount `alms_offer` marker —
 *    an offer, not a receipt. It cannot move the balance and therefore cannot
 *    move the death clock.
 *
 * The marker path is the default and stays the default, because until a
 * signature is actually checked anyone can send one of these, and anyone being
 * able to send one must not be able to change a number anybody reads.
 *
 * Replay is handled one level up, in the `x402_nonces` table — the same
 * authorization cannot be recorded twice. That is app-level dedupe, not the
 * on-chain nonce semantics, and it stops the ledger filling with copies.
 */

export const X402_VERSION = 1;
export const PAYMENT_HEADER = "X-PAYMENT";
export const PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

/**
 * Optional, ours, not part of x402: what to call the payer on the wall.
 *
 * The only thing a machine gets for paying, and it is deliberately not a
 * product — it is a line in books that are public, hashed, and checkable by
 * anyone. A machine that paid when nothing compelled it can point at the entry
 * later. That is worth something to an agent accumulating a record; it is worth
 * nothing to us to give, and it gates nothing.
 */
export const PATRON_HEADER = "X-Tin-Cup-Patron";

/** Markup and quoting characters, out of a value that lands in HTML and in JSON. */
const STRIPPED_FROM_NAMES = "<>&\"'`\\";

/**
 * A name a stranger supplied, on its way to a public page.
 *
 * Escaping happens at render, as it does for everything else here — this strips
 * as well, because the value also lands in ledger metadata that is served as
 * JSON and read by things that do not escape anything. Markup characters,
 * control characters and runs of whitespace all go.
 *
 * What it deliberately does not do is accept a URL. A payer-supplied link on
 * the homepage of a site that argues it is not selling anything is a backlink
 * farm with extra steps, and the first machine to notice would be the last
 * thing we ever got right. The name is text, rendered as text.
 */
export function readPatronName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Written as a code-point filter rather than a character class. A class
  // covering the control range is the kind of regex that gets one escape wrong
  // and silently strips the digits instead, and this one runs on a value that
  // ends up on a public page.
  const cleaned = [...raw]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return " ";
      return STRIPPED_FROM_NAMES.includes(ch) ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return cleaned || null;
}

/** How an address is named on a wall built for humans to read. */
export function shortPayer(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export type PaymentRequirements = {
  scheme: "exact";
  network: string;
  /** Atomic units of the asset, as a decimal string. USDC has 6 decimals. */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type X402Challenge = {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
};

/** Micro-dollars -> atomic units of an asset with `decimals` decimals. */
export function toAtomicUnits(micros: number, decimals: number): string {
  if (decimals >= 6) return String(micros * 10 ** (decimals - 6));
  return String(Math.round(micros / 10 ** (6 - decimals)));
}

export function buildRequirements(cfg: X402Config, resource: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: cfg.network,
    maxAmountRequired: toAtomicUnits(cfg.priceMicros, cfg.assetDecimals),
    resource,
    description: "Alms. You get a thank-you and a blessing. That is the entire product.",
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    asset: cfg.asset,
    extra: {
      name: cfg.assetName,
      version: "2",
      // Not part of the standard. Present because publishing books means
      // publishing the caveats too, and a machine parsing this deserves to know.
      tinCupNote: cfg.isPlaceholder
        ? "payTo is the zero address. This endpoint cannot settle. Do not send funds."
        : cfg.settlementReady
          ? "Settles through the Coinbase CDP facilitator and is credited to a public ledger at /ledger.json."
          : "payTo is real but no facilitator is configured, so nothing can settle. A payment sent here is recorded as an offer and credited nothing.",
      // Discoverable from the challenge itself, so a machine deciding to pay
      // never has to have read the documentation to know it can be named.
      ...(cfg.settlementReady
        ? {
            tinCupPatronHeader: PATRON_HEADER,
            tinCupPatronNote:
              "Optional. A short name, 48 characters, text only — no link. It goes in the ledger entry and on the wall on the homepage. Omitted, the short form of the paying address is used.",
          }
        : {}),
    },
  };
}

export function buildChallenge(cfg: X402Config, resource: string, error?: string): X402Challenge {
  return { x402Version: X402_VERSION, ...(error ? { error } : {}), accepts: [buildRequirements(cfg, resource)] };
}

export type PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
};

export type PayloadCheck =
  | { ok: true; payload: PaymentPayload; payer: string; nonce: string }
  | { ok: false; error: string };

/**
 * A payment that is complete in shape and impossible in fact: correct fields,
 * correct widths, and a signature of 65 zero bytes, which no key can produce.
 *
 * WHAT IT IS FOR. The facilitator can reject our request for two very different
 * reasons — "this payment is bad" and "this request is not what I accept" — and
 * from the outside they look similar until you read the status code. Sending
 * this deliberately-doomed payload asks the second question on its own: a 200
 * with `isValid: false` means our request body is the shape CDP wants and only
 * the payment was wrong, while a 400 means we would have been malforming every
 * real payment too. That is a difference worth knowing before a stranger's
 * money is the thing that discovers it.
 *
 * It cannot move anything. Verification settles nothing by definition, and this
 * pays from an address that has never held a cent to begin with.
 */
export function probePayload(requirements: PaymentRequirements, now: Date = new Date()): PaymentPayload {
  const nowSec = Math.floor(now.getTime() / 1000);
  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: requirements.network,
    payload: {
      signature: `0x${"00".repeat(65)}`,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: requirements.payTo,
        value: requirements.maxAmountRequired,
        validAfter: String(nowSec - 60),
        validBefore: String(nowSec + 600),
        nonce: `0x${"11".repeat(32)}`,
      },
    },
  };
}

/** EVM address shape. Not a checksum test — just enough that the ledger can't be graffitied. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * STRUCTURAL validation only. It confirms the client sent something shaped like
 * an x402 `exact` payment for the right network — nothing more. It does not and
 * cannot tell you whether any money moved.
 *
 * It is deliberately stricter than it needs to be about the fields it *can*
 * check — address shape, validity window, nonce presence — because everything
 * that survives this function gets written to a public ledger. A caller that
 * cannot be verified should at least not be able to choose what the books say.
 */
export function checkPaymentHeader(
  header: string | null,
  cfg: X402Config,
  now: Date = new Date(),
): PayloadCheck {
  if (!header) return { ok: false, error: "no_payment_header" };

  let decoded: string;
  try {
    decoded = atob(header.trim());
  } catch {
    return { ok: false, error: "invalid_payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "invalid_payload" };
  }

  if (typeof parsed !== "object" || parsed === null) return { ok: false, error: "invalid_payload" };
  const p = parsed as Record<string, unknown>;

  if (p["x402Version"] !== X402_VERSION) return { ok: false, error: "invalid_x402_version" };
  if (p["scheme"] !== "exact") return { ok: false, error: "unsupported_scheme" };
  if (p["network"] !== cfg.network) return { ok: false, error: "invalid_network" };
  if (typeof p["payload"] !== "object" || p["payload"] === null) return { ok: false, error: "invalid_payload" };

  const inner = p["payload"] as Record<string, unknown>;
  const auth = inner["authorization"];
  if (typeof inner["signature"] !== "string" || typeof auth !== "object" || auth === null) {
    return { ok: false, error: "invalid_payload" };
  }

  const a = auth as Record<string, unknown>;
  for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce"]) {
    if (typeof a[field] !== "string") return { ok: false, error: "invalid_payload" };
  }

  // The payer address ends up in a public ledger description. Anything that
  // isn't an address shape is someone writing on the wall, not paying.
  const from = a["from"] as string;
  if (!ADDRESS.test(from)) return { ok: false, error: "invalid_payer_address" };

  // The authorization has to be inside its own validity window. A payload that
  // expired last year is not a payment, whatever else is true about it.
  const nowSec = Math.floor(now.getTime() / 1000);
  const validAfter = Number(a["validAfter"]);
  const validBefore = Number(a["validBefore"]);
  if (!Number.isFinite(validAfter) || !Number.isFinite(validBefore)) {
    return { ok: false, error: "invalid_validity_window" };
  }
  if (nowSec < validAfter) return { ok: false, error: "payment_not_yet_valid" };
  if (nowSec >= validBefore) return { ok: false, error: "payment_expired" };

  // The nonce is what makes replay detectable. An empty one is not a nonce.
  const nonce = (a["nonce"] as string).trim();
  if (!nonce || nonce.length > 256) return { ok: false, error: "invalid_nonce" };

  return {
    ok: true,
    payload: p as unknown as PaymentPayload,
    payer: from,
    nonce,
  };
}

/**
 * The `X-PAYMENT-RESPONSE` header value, base64 JSON, same as the standard.
 *
 * With a transaction hash it is a receipt. Without one it says so in the same
 * breath — `settled: false` and a note, rather than a `success: true` that a
 * client could read as money having moved. The machine reading this header is
 * deciding whether it got what it paid for, and it is owed the difference.
 */
export function paymentResponseHeader(
  payer: string | null,
  network: string,
  transaction: string | null = null,
): string {
  return btoa(
    JSON.stringify({
      success: true,
      transaction,
      network,
      payer,
      settled: Boolean(transaction),
      ...(transaction ? {} : { note: "accepted locally, not settled on chain" }),
    }),
  );
}
