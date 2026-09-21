import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.ts";
import { ProviderUnavailableError, classifyHttpFailure } from "./provider.ts";
import { costMicros } from "./pricing.ts";

/**
 * THE PRODUCTION PROVIDER, and still inert locally.
 *
 * Two independent switches must both be thrown before this class can make a
 * request: `LLM_PROVIDER === "openai"` and `LLM_LIVE_CALLS_ENABLED === "true"`,
 * plus a non-empty `OPENAI_API_KEY`. Local dev sets none of them — the mock is
 * the default and stays the default. The `production` environment in
 * wrangler.toml sets the first two, and the key arrives as a deploy-time secret
 * that exists nowhere in this repo.
 *
 * It calls the REST endpoint directly rather than via the `openai` package, for
 * the same reason the Anthropic one does: adding a dependency we have decided
 * not to use is how unused dependencies become used ones.
 *
 * Chat Completions rather than Responses. The Responses API is the one OpenAI
 * points new work at, but Chat Completions is the smaller contract — one POST,
 * a `usage` object with the two numbers the ledger needs — and everything this
 * project asks a model to do is one turn with no state. If a turn ever needs
 * tools or reasoning controls, that is the moment to move, not before.
 */

const API_URL = "https://api.openai.com/v1/chat/completions";

export type OpenAiProviderConfig = {
  apiKey: string | undefined;
  liveCallsEnabled: boolean;
  /** Overridable for a proxy or a compatible endpoint. Defaults to OpenAI. */
  baseUrl?: string;
  /** Injectable so the failure paths can be tested without a network call. */
  fetchImpl?: typeof fetch;
};

/**
 * Live calls are off, or there is no key.
 *
 * A subclass of `ProviderUnavailableError` on purpose. This is the state a
 * deployment is in between `wrangler deploy` and `wrangler secret put
 * OPENAI_API_KEY`, and in that window every busk would otherwise be a 500 with
 * a stack trace behind it. It is the same *kind* of fact as an empty account —
 * "I cannot think right now" — so it takes the same honest exit.
 */
export class OpenAiLiveCallsDisabledError extends ProviderUnavailableError {
  constructor(reason: string) {
    super("disabled", reason);
    this.name = "OpenAiLiveCallsDisabledError";
  }
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";

  private readonly config: OpenAiProviderConfig;

  constructor(config: OpenAiProviderConfig) {
    this.config = config;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.config.liveCallsEnabled) {
      throw new OpenAiLiveCallsDisabledError("LLM_LIVE_CALLS_ENABLED is not 'true'");
    }
    if (!this.config.apiKey) {
      throw new OpenAiLiveCallsDisabledError("no OPENAI_API_KEY in the environment");
    }

    const doFetch = this.config.fetchImpl ?? fetch;

    let res: Response;
    try {
      res = await doFetch(this.config.baseUrl ?? API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          // The GPT-5.6 family takes `max_completion_tokens`; `max_tokens` is the
          // legacy name and is rejected by the reasoning models. This bound is
          // the per-call spend ceiling, so getting the field name wrong would be
          // getting the brake wrong.
          max_completion_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.prompt },
          ],
        }),
      });
    } catch (err) {
      // DNS, TLS, timeout — the request never landed, so nothing was billed.
      throw new ProviderUnavailableError("unreachable", String((err as Error)?.message ?? err));
    }

    if (!res.ok) {
      // Read the body for the provider's own error code — 429 means both "slow
      // down" and "you are out of credit", and only one of those is worth
      // panicking about. The text is classified and then dropped; it can name
      // the account and this project publishes quite enough already.
      const detail = await res.text().catch(() => "");
      throw classifyHttpFailure(res.status, detail);
    }

    const body = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;

    if (!body) throw new ProviderUnavailableError("malformed", "response was not JSON", res.status);

    const text = body.choices?.[0]?.message?.content ?? "";

    // Billed usage comes from the API, never from an estimate. The ledger
    // publishes these numbers, so they have to be the ones we were charged for.
    //
    // `completion_tokens` already includes reasoning tokens, which are billed
    // at the output rate — so a turn that thought hard costs more than its
    // visible length, and the ledger says so because it prices this number.
    //
    // A 200 with no usage block is the nastiest case here: the money has
    // already been spent and we cannot say how much. Refusing is still the only
    // honest move — an entry priced off a guess is exactly the entry this
    // project promises does not exist — but it is recorded as a provider
    // failure rather than shown, so the page says "I could not bill that" and
    // the turn is not published.
    const usage = body.usage;
    if (typeof usage?.prompt_tokens !== "number" || typeof usage?.completion_tokens !== "number") {
      throw new ProviderUnavailableError(
        "malformed",
        "no usage block returned — refusing to guess what it cost",
        res.status,
      );
    }

    return {
      text,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      model: req.model,
      costMicros: costMicros(req.model, usage.prompt_tokens, usage.completion_tokens),
      simulated: false,
    };
  }
}
