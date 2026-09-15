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
