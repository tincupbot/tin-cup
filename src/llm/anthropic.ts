import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.ts";
import { ProviderUnavailableError, classifyHttpFailure } from "./provider.ts";
import { costMicros } from "./pricing.ts";

/**
 * INERT. Written, never wired up, never called.
 *
 * Two independent switches must both be thrown before this class can make a
 * request: `LLM_LIVE_CALLS_ENABLED === "true"` and a non-empty `ANTHROPIC_API_KEY`.
 * Neither exists in this repo. There is no default, no fallback, and no code
 * path that constructs this provider unless `LLM_PROVIDER` is explicitly set to
 * "anthropic" — which nothing sets.
 *
 * It calls the REST endpoint directly rather than via `@anthropic-ai/sdk`,
 * because adding a dependency we have decided not to use is how unused
 * dependencies become used ones. If Ben ever approves real spend, swapping this
 * for the official SDK is the first thing to do — see README, "Before this can
 * go live".
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export type AnthropicProviderConfig = {
  apiKey: string | undefined;
  liveCallsEnabled: boolean;
};

/** Same reasoning as the OpenAI one: a missing key is "I cannot think", not a 500. */
export class LiveCallsDisabledError extends ProviderUnavailableError {
  constructor(reason: string) {
    super("disabled", reason);
    this.name = "LiveCallsDisabledError";
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";

  private readonly config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (!this.config.liveCallsEnabled) {
      throw new LiveCallsDisabledError("LLM_LIVE_CALLS_ENABLED is not 'true'");
    }
    if (!this.config.apiKey) {
      throw new LiveCallsDisabledError("no ANTHROPIC_API_KEY in the environment");
    }

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
        }),
      });
    } catch (err) {
      throw new ProviderUnavailableError("unreachable", String((err as Error)?.message ?? err));
    }

    if (!res.ok) {
      throw classifyHttpFailure(res.status, await res.text().catch(() => ""));
    }

    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const text = body.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");

    // Billed usage comes from the API, never from an estimate. The ledger
    // publishes these numbers, so they have to be the ones we were charged for.
    const inputTokens = body.usage.input_tokens;
    const outputTokens = body.usage.output_tokens;

    return {
      text,
      inputTokens,
      outputTokens,
      model: req.model,
      costMicros: costMicros(req.model, inputTokens, outputTokens),
      simulated: false,
    };
  }
}
