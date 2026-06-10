import OpenAI from "openai";
import { env } from "../config/env.js";
import type {
  LlmCallOptions,
  LlmMessage,
  LlmProvider,
  LlmResponse,
} from "./llm-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI LLM Provider
// ─────────────────────────────────────────────────────────────────────────────

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export class OpenAiLlmProvider implements LlmProvider {
  async chat(
    messages: LlmMessage[],
    options: LlmCallOptions = {}
  ): Promise<LlmResponse> {
    const {
      model = env.OPENAI_EXTRACTION_MODEL,
      maxTokens = 512,
      temperature = 0,
      timeoutMs = env.LLM_TIMEOUT_MS,
      jsonMode = false,
    } = options;

    const start = Date.now();

    const response_format = jsonMode
      ? ({ type: "json_object" } as const)
      : ({ type: "text" } as const);

    const completion = await Promise.race([
      client.chat.completions.create({
        model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature,
        response_format,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`LLM timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);

    const latencyMs = Date.now() - start;
    const choice = completion.choices[0];
    const content = choice?.message?.content ?? "";
    const usage = completion.usage;

    return {
      content,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      latencyMs,
      model: completion.model,
    };
  }
}

/** Singleton. */
export const llmProvider: LlmProvider = new OpenAiLlmProvider();
