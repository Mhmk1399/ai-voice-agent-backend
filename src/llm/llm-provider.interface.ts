// ─────────────────────────────────────────────────────────────────────────────
// LLM Provider Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  jsonMode?: boolean;
}

export interface LlmResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  model: string;
}

export interface LlmProvider {
  chat(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse>;
}
