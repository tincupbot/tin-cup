import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.ts";
import { costMicros } from "./pricing.ts";

/**
 * INERT. Written, never wired up, never called.
 *
 * Same two independent switches as the Anthropic provider, and both must be
 * thrown before this class can make a request: `LLM_LIVE_CALLS_ENABLED === "true"`
 * and a non-empty `OPENAI_API_KEY`. Neither exists in this repo. There is no
 * default, no fallback, and no code path that constructs this provider unless
 * `LLM_PROVIDER` is explicitly set to "openai" — which nothing sets.
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
};

export class OpenAiLiveCallsDisabledError extends Error {
  constructor(reason: string) {
    super(`live LLM calls are disabled: ${reason}`);
    this.name = "OpenAiLiveCallsDisabledError";
  }
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";

  constructor(private readonly config: OpenAiProviderConfig) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.config.liveCallsEnabled) {
      throw new OpenAiLiveCallsDisabledError("LLM_LIVE_CALLS_ENABLED is not 'true'");
    }
    if (!this.config.apiKey) {
      throw new OpenAiLiveCallsDisabledError("no OPENAI_API_KEY in the environment");
    }

    const res = await fetch(this.config.baseUrl ?? API_URL, {
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

    if (!res.ok) {
      throw new Error(`openai api returned ${res.status}`);
    }

    const body = (await res.json()) as {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = body.choices?.[0]?.message?.content ?? "";

    // Billed usage comes from the API, never from an estimate. The ledger
    // publishes these numbers, so they have to be the ones we were charged for.
    //
    // `completion_tokens` already includes reasoning tokens, which are billed
    // at the output rate — so a turn that thought hard costs more than its
    // visible length, and the ledger says so because it prices this number.
    const usage = body.usage;
    if (typeof usage?.prompt_tokens !== "number" || typeof usage?.completion_tokens !== "number") {
      throw new Error("openai api returned no usage — refusing to guess what it cost");
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
