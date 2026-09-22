import type { PaymentPayload, PaymentRequirements } from "./x402.ts";

/**
 * The Coinbase CDP x402 facilitator, over its REST API.
 *
 * WHY THIS EXISTS: `src/x402.ts` can check the *shape* of a payment and nothing
 * else. It cannot tell you whether a signature is real, whether the payer holds
 * the funds, or whether anything moved on chain. Those three questions are what
 * a facilitator answers, and until something answers them nothing may be
 * credited. This file is that answer.
 *
 * WHY CDP AND NOT A KEYLESS FACILITATOR: it screens payers against OFAC and KYT
 * lists before settling. This endpoint takes money from strangers in public, so
 * declining a sanctioned address is worth an API key. Free to 1,000 on-chain
 * settlements a month, then $0.001 each.
 *
 * WHY HAND-ROLLED AND NOT `@coinbase/cdp-sdk`: the SDK is ~467 packages and
 * assumes Node. This is two POSTs and a JWT, and Workers has Ed25519 in
 * WebCrypto. See the same argument at the top of `src/x402.ts`.
 *
 * WHAT IT DELIBERATELY WILL NOT DO: it never decides to credit. It reports what
 * the facilitator said. The caller credits only on `settled` with a transaction
 * hash, and the failure of anything here — timeout, 500, malformed reply — is a
 * refusal, never a credit. See `/alms` in index.ts.
 */

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE = `https://${CDP_HOST}/platform`;

/** Outbound calls on the request path get a leash. Better to refuse than hang. */
const TIMEOUT_MS = 12_000;

export type FacilitatorConfig = {
  apiKeyId: string;
  apiKeySecret: string;
};

/** True only when both halves of the credential are present. */
export function facilitatorConfig(env: {
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}): FacilitatorConfig | null {
  const id = env.CDP_API_KEY_ID?.trim();
  const secret = env.CDP_API_KEY_SECRET?.trim();
  if (!id || !secret) return null;
  return { apiKeyId: id, apiKeySecret: secret };
}

// ---------------------------------------------------------------------------
// JWT. CDP wants an EdDSA bearer token, scoped to the exact method+host+path.
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * CDP hands out the Ed25519 secret as base64 of `seed || publicKey` (64 bytes).
 * WebCrypto imports PKCS#8, so the 32-byte seed gets the fixed DER prelude for
 * an Ed25519 private key wrapped round it. The prelude is constant — it encodes
 * "PrivateKeyInfo, version 0, algorithm id-Ed25519, 32-octet key" and nothing
 * about this particular key.
 */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function importEd25519(apiKeySecret: string): Promise<CryptoKey> {
  const raw = fromBase64(apiKeySecret);
  if (raw.length !== 64) {
    throw new Error(`cdp_key_malformed: expected 64 bytes, got ${raw.length}`);
  }
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(raw.subarray(0, 32), PKCS8_ED25519_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** A bearer token good for 120 seconds and for exactly one method+path. */
export async function generateJwt(
  cfg: FacilitatorConfig,
  method: string,
  path: string,
  now: Date = new Date(),
): Promise<string> {
  const key = await importEd25519(cfg.apiKeySecret);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12))).slice(0, 16);
  const issued = Math.floor(now.getTime() / 1000);

  const header = { alg: "EdDSA", typ: "JWT", kid: cfg.apiKeyId, nonce };
  const claims = {
    sub: cfg.apiKeyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: issued,
    exp: issued + 120,
    // Scoping the token to one request is the whole point: a leaked token is
    // good for two minutes against one endpoint, not against the account.
    uri: `${method.toUpperCase()} ${CDP_HOST}/platform${path}`,
  };

  const signingInput = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// verify / settle
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; payer: string | null }
  | { ok: false; reason: string; detail: string };

export type SettleResult =
  | { ok: true; transaction: string; network: string; payer: string | null; amountAtomic: string | null }
  | { ok: false; reason: string; detail: string };

type CdpBody = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

async function request(
  cfg: FacilitatorConfig,
  method: "GET" | "POST",
  path: string,
  body: CdpBody | null,
  fetchImpl: typeof fetch,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const jwt = await generateJwt(cfg, method, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${CDP_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** POST with a body. The two money calls below are the only callers. */
function post(
  cfg: FacilitatorConfig,
  path: string,
  body: CdpBody,
  fetchImpl: typeof fetch,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return request(cfg, "POST", path, body, fetchImpl);
}

export type PreflightResult =
  | { ok: true; kinds: Array<{ scheme: string; network: string }> }
  | { ok: false; reason: string; detail: string };

/**
 * Does the credential work, and does the facilitator support what we advertise?
 *
 * WHY THIS EXISTS AND WHY IT IS NOT ON THE MONEY PATH: everything else here was
 * tested against a stub, and a stub cannot tell you that the JWT is wrong. The
 * Ed25519 signing, the `uri` claim format, the key encoding and the host are
 * four independent chances to be subtly wrong, and all four fail identically at
 * the worst possible moment — the first stranger's payment. `GET /supported` is
 * authenticated, read-only, moves nothing and costs nothing, so it turns "the
 * credential is probably fine" into a fact before anything is switched on.
 *
 * It is operator-only (see `/__facilitator` in index.ts). A public endpoint
 * reporting the health of our payment credential is a probe for someone else.
 */
export async function facilitatorPreflight(
  cfg: FacilitatorConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PreflightResult> {
  let res: { status: number; json: Record<string, unknown> | null };
  try {
    res = await request(cfg, "GET", "/v2/x402/supported", null, fetchImpl);
  } catch (err) {
    return { ok: false, reason: "facilitator_unreachable", detail: String(err) };
  }

  if (res.status === 401 || res.status === 403) {
    // The one failure worth naming precisely: the key is present and rejected.
    return {
      ok: false,
      reason: "unauthorized",
      detail: `The facilitator rejected the credential (${res.status}). The key id, the secret or the JWT is wrong.`,
    };
  }
  if (res.status !== 200 || !res.json) {
    return { ok: false, reason: "facilitator_error", detail: `supported returned ${res.status}` };
  }

  const raw = res.json["kinds"];
  const kinds = Array.isArray(raw)
    ? raw.flatMap((k) => {
        const rec = k as Record<string, unknown>;
        const scheme = str(rec["scheme"]);
        const network = str(rec["network"]);
        return scheme && network ? [{ scheme, network }] : [];
      })
    : [];
  return { ok: true, kinds };
}

/**
 * Is this payment real and payable? Free, and it does not move anything.
 * Called before the nonce is claimed so a bad payload costs us nothing.
 */
export async function verifyPayment(
  cfg: FacilitatorConfig,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  let res: { status: number; json: Record<string, unknown> | null };
  try {
    res = await post(cfg, "/v2/x402/verify", { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }, fetchImpl);
  } catch (err) {
    // A facilitator we cannot reach is a payment we cannot accept. Refuse.
    return { ok: false, reason: "facilitator_unreachable", detail: String(err) };
  }

  const body = res.json;
  if (res.status !== 200 || !body) {
    return { ok: false, reason: "facilitator_error", detail: `verify returned ${res.status}` };
  }
  if (body["isValid"] === true) {
    return { ok: true, payer: str(body["payer"]) };
  }
  return {
    ok: false,
    reason: str(body["invalidReason"]) ?? "payment_invalid",
    detail: str(body["invalidMessage"]) ?? "The facilitator declined this payment.",
  };
}

/**
 * Move the money. Returns a transaction hash or an explanation, never both and
 * never neither. A result without a hash is not a settlement, whatever the
 * `success` flag says — so the hash is checked, not trusted.
 */
export async function settlePayment(
  cfg: FacilitatorConfig,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<SettleResult> {
  let res: { status: number; json: Record<string, unknown> | null };
  try {
    res = await post(cfg, "/v2/x402/settle", { x402Version: 1, paymentPayload: payload, paymentRequirements: requirements }, fetchImpl);
  } catch (err) {
    return { ok: false, reason: "facilitator_unreachable", detail: String(err) };
  }

  const body = res.json;
  if (!body) {
    return { ok: false, reason: "facilitator_error", detail: `settle returned ${res.status} with no body` };
  }

  const tx = str(body["transaction"]);
  if (res.status === 200 && body["success"] === true && tx) {
    return {
      ok: true,
      transaction: tx,
      network: str(body["network"]) ?? requirements.network,
      payer: str(body["payer"]),
      amountAtomic: str(body["amount"]),
    };
  }

  return {
    ok: false,
    reason: str(body["errorReason"]) ?? (res.status === 200 ? "settlement_incomplete" : `http_${res.status}`),
    detail: str(body["errorMessage"]) ?? "Settlement did not complete and nothing was credited.",
  };
}

/**
 * Atomic units of an asset back to micro-dollars. The inverse of
 * `toAtomicUnits`. Returns null on anything that is not a clean integer,
 * because a number we cannot parse must not become a number in the books.
 */
export function atomicToMicros(atomic: string, decimals: number): number | null {
  if (!/^\d+$/.test(atomic)) return null;
  const n = Number(atomic);
  if (!Number.isSafeInteger(n)) return null;
  if (decimals >= 6) {
    const divisor = 10 ** (decimals - 6);
    if (n % divisor !== 0) return null;
    return n / divisor;
  }
  return n * 10 ** (6 - decimals);
}
