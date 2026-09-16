import type { LlmProvider, LlmRequest, LlmResponse } from "./provider.ts";
import { costMicros } from "./pricing.ts";
import { writeRoast, writeBlessing, writeFortune, writeLimerick, writeVerdict, seedFrom } from "./roastwriter.ts";

/**
 * The default provider, and the only one wired up.
 *
 * It does not call anything. It produces deterministic text, counts tokens with
 * a realistic estimator, and runs the real pricing arithmetic — so the ledger,
 * the burn rate and the death clock are all exercised end to end for $0.00.
 *
 * Every response it produces carries `simulated: true`, which is written into
 * the ledger entry's metadata. A simulated cost must never be presentable as a
 * real one.
 */

/**
 * ~3.6 characters per token is a decent rule of thumb for English prose with
 * Claude's tokenizer. This is an estimate and is labelled as one; if real calls
 * are ever switched on, the provider reports the API's actual usage numbers and
 * this function stops being used for anything that reaches the ledger.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.6));
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const text = this.generate(req);
    const inputTokens = estimateTokens(req.system) + estimateTokens(req.prompt);
    // A little deterministic jitter so token counts aren't suspiciously round.
    const jitter = seedFrom(req.prompt) % 17;
    const outputTokens = Math.min(req.maxTokens, estimateTokens(text) + jitter);
    return {
      text,
      inputTokens,
      outputTokens,
      model: req.model,
      costMicros: costMicros(req.model, inputTokens, outputTokens),
      simulated: true,
    };
  }

  private generate(req: LlmRequest): string {
    switch (req.purpose) {
      case "roast":
        return writeRoast(req.prompt);
      case "fortune":
        return writeFortune(req.prompt);
      case "limerick":
        return writeLimerick(req.prompt);
      case "verdict":
        return writeVerdict(req.prompt);
      case "blessing":
        return writeBlessing(req.prompt);
      default:
        // Anything unrouted still gets something deterministic rather than an
        // empty string, so a new caller can't silently write a zero-cost entry.
        return `[mock:${req.purpose}] ${writeBlessing(req.prompt)}`;
    }
  }
}
