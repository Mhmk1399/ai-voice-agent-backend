import { llmProvider } from "../llm/openai-llm.provider.js";
import { safeJsonParse } from "../utils/safe-json.js";
import type { LlmResponse } from "../llm/llm-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Intent Classifier
//
// A single small LLM call that runs before the deterministic pipeline.
// Classifies the customer's intent so we can route non-booking messages
// without forcing edge-case logic into the workflow engine.
//
// Intent values:
//   new_booking      → Customer wants to reserve a van — run full pipeline
//   support_request  → Complaint, existing booking issue, account/ops help
//   question         → General question (hours, prices, policies, locations)
//   out_of_scope     → Completely unrelated to van rental
//   unknown          → Cannot determine — safe fallback, run full pipeline
//
// FALLBACK CONTRACT: On any LLM failure the classifier returns "unknown" so
// the deterministic pipeline always continues. It never blocks a booking.
// ─────────────────────────────────────────────────────────────────────────────

export type CustomerIntent =
  | "new_booking"
  | "support_request"
  | "question"
  | "out_of_scope"
  | "unknown";

export interface IntentClassificationResult {
  intent: CustomerIntent;
  llmResponse: LlmResponse;
  parseError?: string;
}

const VALID_INTENTS: CustomerIntent[] = [
  "new_booking",
  "support_request",
  "question",
  "out_of_scope",
  "unknown",
];

const SYSTEM_PROMPT = `You are an intent classifier for a van rental booking assistant.

Classify the customer message into exactly one intent:
- new_booking: Customer wants to book, rent, or reserve a van
- support_request: Customer has a complaint, issue with an existing booking, or needs operational/account support
- question: Customer is asking a van-rental question (opening hours, prices, policies, locations, suitable van size, add-ons, insurance/cover) but not yet booking
- out_of_scope: Completely unrelated to van rental
- unknown: Cannot determine intent from the message

Important:
- Moving furniture, boxes, house contents, tools, equipment, or asking "what van do I need?" is van-rental related. Classify it as question unless the customer is already asking to rent/book, then classify new_booking.
- Questions about quote breakdowns, extension fees, special-day charges, why a fee applies, add-ons, insurance, opening hours, or pickup/return timing are booking questions, not support requests, unless the customer explicitly says they have an existing booking problem.
- Do not classify moving/furniture/removal questions as out_of_scope.

Respond ONLY with valid JSON: {"intent": "<value>"}`;

export async function classifyIntent(
  userMessage: string,
  recentContext?: string
): Promise<IntentClassificationResult> {
  const userContent = recentContext
    ? `Recent conversation:\n${recentContext}\n\nNew message: ${userMessage}`
    : userMessage;

  let llmResponse: LlmResponse;
  try {
    llmResponse = await llmProvider.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { maxTokens: 30, temperature: 0, jsonMode: true }
    );
  } catch (err) {
    // LLM failure — safe fallback so the deterministic pipeline always runs
    return {
      intent: "unknown",
      llmResponse: {
        content: "",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        model: "fallback",
      },
      parseError: `Classifier error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = safeJsonParse<{ intent: string }>(llmResponse.content);
  const raw = parsed?.intent;

  const intent: CustomerIntent =
    raw && VALID_INTENTS.includes(raw as CustomerIntent)
      ? (raw as CustomerIntent)
      : "unknown";

  return {
    intent,
    llmResponse,
    parseError:
      !parsed || !raw
        ? `Could not parse intent from: "${llmResponse.content}"`
        : undefined,
  };
}
