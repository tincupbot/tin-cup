import type { ModelId } from "./pricing.ts";

export type LlmRequest = {
  model: ModelId;
  system: string;
  prompt: string;
  maxTokens: number;
  /** Free-form tag so the ledger line says what the money bought. */
  purpose: string;
};

export type LlmResponse = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: ModelId;
  costMicros: number;
  /** True when no real API call happened. Propagates into the ledger metadata. */
  simulated: boolean;
};

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Why a provider could not produce a turn. Not a taxonomy for its own sake —
 * each of these gets its own sentence on the page, because "I have no money
 * left" and "the company that sells me tokens has stopped taking my card" are
 * different claims and only one of them is about the ledger.
 */
export type ProviderFailure =
  /** Account out of credit, or over a hard billing limit. The one that was predicted. */
  | "quota"
  /** Key rejected, revoked, or absent. */
  | "auth"
  /** Asked to slow down. Transient. */
  | "rate_limit"
  /** The provider is up but broke. 5xx. */
  | "upstream"
  /** The request never arrived: DNS, TLS, timeout. */
  | "unreachable"
  /** Live calls are switched off, or the key was never configured. Ours, not theirs. */
  | "disabled"
  /** Answered, but not with something that can be honestly billed. */
  | "malformed";

/**
 * A provider could not be reached, could not be paid for, or could not be
 * billed honestly. Thrown instead of a bare Error so the route layer can say
 * something true and in character rather than returning a 500.
 *
 * THE FAILURE THIS EXISTS FOR, stated plainly, because it is the one that was
 * written down as inevitable before it happened: donations land in a payment
 * account and inference is paid from a separate API account, with a human
 * moving money between them by hand. So the OpenAI credit can run dry while
 * the ledger still shows a healthy balance and a death clock with days on it.
 * At that moment the site is solvent and mute at the same time, and the only
 * dishonest option is to pretend otherwise.
 */
export class ProviderUnavailableError extends Error {
  // Assigned in the body, not declared as constructor parameter properties:
  // `node --experimental-strip-types` is strip-only and rejects those, and the
  // scripts/ tooling runs that way. See LedgerContentionError for the full note.
  readonly reason: ProviderFailure;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(reason: ProviderFailure, detail: string, status?: number) {
    super(`provider unavailable (${reason}): ${detail}`);
    this.name = "ProviderUnavailableError";
    this.reason = reason;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Map an HTTP failure from a provider onto one of the reasons above.
 *
 * `body` is the raw response text, read once by the caller. It is inspected for
 * the provider's own error code — OpenAI returns 429 for both "you are going
 * too fast" and "you are out of money", and those deserve different sentences —
 * but the status code is what decides when the body says nothing useful.
 *
 * The body is never rendered. It can contain organisation names and account
 * identifiers, and this project publishes enough about itself already.
 */
export function classifyHttpFailure(status: number, body: string): ProviderUnavailableError {
  const lower = body.toLowerCase();
  const outOfMoney =
    lower.includes("insufficient_quota") ||
    lower.includes("insufficient quota") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("billing_hard_limit_reached") ||
    lower.includes("credit balance is too low");

  if (status === 401 || status === 403) return new ProviderUnavailableError("auth", `http ${status}`, status);
  if (status === 402) return new ProviderUnavailableError("quota", `http ${status}`, status);
  if (status === 429) {
    return outOfMoney
      ? new ProviderUnavailableError("quota", "http 429, insufficient quota", status)
      : new ProviderUnavailableError("rate_limit", "http 429", status);
  }
  if (outOfMoney) return new ProviderUnavailableError("quota", `http ${status}`, status);
  if (status >= 500) return new ProviderUnavailableError("upstream", `http ${status}`, status);
  return new ProviderUnavailableError("upstream", `http ${status}`, status);
}
