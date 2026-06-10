import { z } from "zod";
import { env } from "../config/env.js";
import { llmProvider } from "./openai-llm.provider.js";
import type { LlmResponse } from "./llm-provider.interface.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import type { TranscriptMessage } from "../memory/memory-store.interface.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Structured Extraction Schema
// Only fields that deterministic code cannot reliably extract.
// ─────────────────────────────────────────────────────────────────────────────

const ExtractionSchema = z.object({
  pickupDateText: z.string().nullish(),
  returnDateText: z.string().nullish(),
  driverAge: z.number().int().min(16).max(100).nullish(),
  selectedGear: z.enum(["manual", "automatic"]).nullish(),
  customerPhone: z.string().nullish(),
  customerName: z.string().nullish(),
  // Fallbacks: only populated if deterministic resolver found nothing
  officeName: z.string().nullish(),
  categoryName: z.string().nullish(),
  // Intent
  wantsConfirmation: z.boolean().nullish(),
  wantsCancellation: z.boolean().nullish(),
  wantsHumanHandoff: z.boolean().nullish(),
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

export interface LlmExtractionCall {
  result: ExtractionResult;
  llmResponse: LlmResponse;
  parseError?: string;
}

export interface LlmResponseCall {
  reply: string;
  llmResponse: LlmResponse;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction Service
// ─────────────────────────────────────────────────────────────────────────────

function buildExtractionPrompt(
  userMessage: string,
  draft: BookingDraft,
  context: BusinessContext,
  recentTurns: TranscriptMessage[]
): string {
  const officeNames = context.offices.map((o) => o.name).join(", ");
  const categoryNames = context.categories.map((c) => c.name).join(", ");

  const history = recentTurns
    .slice(-4)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  return `You are a structured data extractor for a van rental booking assistant.

Extract ONLY what the customer explicitly says. Do not invent or guess.

Available offices: ${officeNames}
Available categories: ${categoryNames}

Conversation history:
${history || "(none)"}

Customer message: "${userMessage}"

Current booking state:
- Office: ${draft.officeName ?? "not set"}
- Category: ${draft.categoryName ?? "not set"}
- Pickup date: ${draft.pickupDateText ?? "not set"}
- Return date: ${draft.returnDateText ?? "not set"}
- Driver age: ${draft.driverAge ?? "not set"}

Return JSON with these fields (null if not mentioned):
{
  "pickupDateText": string | null,
  "returnDateText": string | null,
  "driverAge": number | null,
  "selectedGear": "manual" | "automatic" | null,
  "customerPhone": string | null,
  "customerName": string | null,
  "officeName": string | null,
  "categoryName": string | null,
  "wantsConfirmation": boolean | null,
  "wantsCancellation": boolean | null,
  "wantsHumanHandoff": boolean | null
}

Rules:
- pickupDateText and returnDateText: preserve natural language exactly as said (e.g. "tomorrow at 10", "Friday evening")
- driverAge: only if customer explicitly states their age as a number
- selectedGear: only if explicitly mentioned
- officeName: only set if deterministic matching might have failed; use exact name from available list
- categoryName: only set if deterministic matching might have failed; use exact name from available list
- wantsConfirmation: true if customer says yes/confirm/go ahead/book it etc.
- wantsCancellation: true if customer says cancel/stop/nevermind etc.
- wantsHumanHandoff: true if customer asks to speak to a person/human/agent`;
}

export async function extractFromUserMessage(params: {
  userMessage: string;
  draft: BookingDraft;
  context: BusinessContext;
  recentTurns: TranscriptMessage[];
}): Promise<LlmExtractionCall> {
  const { userMessage, draft, context, recentTurns } = params;

  const prompt = buildExtractionPrompt(userMessage, draft, context, recentTurns);

  const llmResponse = await llmProvider.chat(
    [{ role: "user", content: prompt }],
    {
      model: env.OPENAI_EXTRACTION_MODEL,
      maxTokens: 300,
      temperature: 0,
      jsonMode: true,
    }
  );

  let result: ExtractionResult = {};
  let parseError: string | undefined;

  try {
    const raw = JSON.parse(llmResponse.content);
    const parsed = ExtractionSchema.safeParse(raw);
    if (parsed.success) {
      result = parsed.data;
    } else {
      parseError = parsed.error.message;
      // Partial fallback
      const r = raw as Record<string, unknown>;
      result = {
        pickupDateText: typeof r.pickupDateText === "string" ? r.pickupDateText : undefined,
        returnDateText: typeof r.returnDateText === "string" ? r.returnDateText : undefined,
        driverAge: typeof r.driverAge === "number" ? r.driverAge : undefined,
        customerPhone: typeof r.customerPhone === "string" ? r.customerPhone : undefined,
        customerName: typeof r.customerName === "string" ? r.customerName : undefined,
        wantsConfirmation: typeof r.wantsConfirmation === "boolean" ? r.wantsConfirmation : undefined,
        wantsCancellation: typeof r.wantsCancellation === "boolean" ? r.wantsCancellation : undefined,
        wantsHumanHandoff: typeof r.wantsHumanHandoff === "boolean" ? r.wantsHumanHandoff : undefined,
      };
    }
  } catch (e) {
    parseError = String(e);
  }

  return { result, llmResponse, parseError };
}

// ─────────────────────────────────────────────────────────────────────────────
// Natural Response Generation
// ─────────────────────────────────────────────────────────────────────────────

export async function generateResponse(params: {
  systemPrompt: string;
  userMessage: string;
  recentTurns: TranscriptMessage[];
  responseHint: string;
}): Promise<LlmResponseCall> {
  const { systemPrompt, userMessage, recentTurns, responseHint } = params;

  const historyMessages = recentTurns.slice(-6).map((t) => ({
    role: t.role as "user" | "assistant",
    content: t.content,
  }));

  const llmResponse = await llmProvider.chat(
    [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      {
        role: "user",
        content: `Customer: "${userMessage}"\n\nRespond with: ${responseHint}`,
      },
    ],
    {
      model: env.OPENAI_RESPONSE_MODEL,
      maxTokens: 120,
      temperature: 0.3,
    }
  );

  return { reply: llmResponse.content.trim(), llmResponse };
}
