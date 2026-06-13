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
  pickupDateISO: z.string().nullish(),
  returnDateISO: z.string().nullish(),
  driverAge: z.number().int().min(16).max(100).nullish(),
  selectedGear: z.enum(["manual", "automatic"]).nullish(),
  customerPhone: z.string().nullish(),
  customerName: z.string().nullish(),
  customerEmail: z.string().nullish(),
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
  const now = new Date().toISOString();

  const history = recentTurns
    .slice(-4)
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  return `You are a structured data extractor for a van rental booking assistant.

Available offices: ${officeNames}
Available categories: ${categoryNames}

Conversation history (most recent last):
${history || "(none)"}

Customer message: "${userMessage}"

Current date/time: ${now}

Current booking state:
- Office: ${draft.officeName ?? "not set"}
- Category: ${draft.categoryName ?? "not set"}
- Pickup date: ${draft.pickupDateText ?? "not set"}
- Return date: ${draft.returnDateText ?? "not set"}
- Pickup ISO: ${draft.pickupDateISO ?? "not set"}
- Return ISO: ${draft.returnDateISO ?? "not set"}
- Driver age: ${draft.driverAge ?? "not set"}

Return JSON with these fields (null if not present):
{
  "pickupDateText": string | null,
  "returnDateText": string | null,
  "pickupDateISO": string | null,
  "returnDateISO": string | null,
  "driverAge": number | null,
  "selectedGear": "manual" | "automatic" | null,
  "customerPhone": string | null,
  "customerName": string | null,
  "customerEmail": string | null,
  "officeName": string | null,
  "categoryName": string | null,
  "wantsConfirmation": boolean | null,
  "wantsCancellation": boolean | null,
  "wantsHumanHandoff": boolean | null
}

Rules:
- pickupDateText / returnDateText: preserve natural language exactly (e.g. "tomorrow at 10", "Friday evening").
- pickupDateISO / returnDateISO: resolve natural dates to ISO-8601 strings only when both the calendar date and clock time are clear. Use Europe/London local wall-clock time with the correct offset. Do not convert a stated local time into UTC in the ISO string. Example: "16th at 3 pm" in British Summer Time should be "YYYY-06-16T15:00:00+01:00", not "T14:00:00+01:00".
- A compact hour after a date means 24-hour local time. Example: "return it at 16th 14" or "16th at 14" means 14:00 on the 16th.
- If the customer gives only a date, such as "tomorrow" or "in 2 days", set the matching DateText but return null for the ISO because the time is still missing.
- If the customer asks for available pickup/return times, preserve the requested date text but return null for pickupDateISO/returnDateISO unless they explicitly chose a clock time.
- If the year is not stated, choose the next future occurrence. If the message gives a range like "tomorrow 9am till 10am day after that", set pickup to the start and return to the end. Return null if ambiguous.
- driverAge: a number. Only set if the customer gives their age.
- selectedGear: only if explicitly mentioned.
- customerPhone: normalize UK phone to the SuccessVan local format: 10 digits without +44 or leading 0. Example: "+447346323799" -> "7346323799"; "07346323799" -> "7346323799".
- customerEmail: set only if the customer gives an email address.
- officeName: USE THE CONVERSATION HISTORY to resolve. If customer says "same office", "that one", "the first option", "the second one", look at what offices were listed in the recent assistant messages and return the matching name exactly as it appears in the available offices list. Return null only if no office was referenced at all this turn.
- categoryName: same rule as officeName. Resolve contextual references from history.
- wantsConfirmation: true if customer says yes/confirm/go ahead/book it/looks good/sure etc.
- wantsCancellation: true if customer says cancel/stop/never mind/no etc.
- wantsHumanHandoff: true if customer asks to speak to a person/human/agent/someone.`;
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
        pickupDateISO: typeof r.pickupDateISO === "string" ? r.pickupDateISO : undefined,
        returnDateISO: typeof r.returnDateISO === "string" ? r.returnDateISO : undefined,
        driverAge: typeof r.driverAge === "number" ? r.driverAge : undefined,
        customerPhone: typeof r.customerPhone === "string" ? r.customerPhone : undefined,
        customerName: typeof r.customerName === "string" ? r.customerName : undefined,
        customerEmail: typeof r.customerEmail === "string" ? r.customerEmail : undefined,
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

export async function generateBusinessAnswer(params: {
  userMessage: string;
  recentTurns: TranscriptMessage[];
  draft: BookingDraft;
  context: BusinessContext;
  continuationQuestion?: string;
}): Promise<LlmResponseCall> {
  const { userMessage, recentTurns, draft, context, continuationQuestion } = params;

  const offices = context.offices
    .map((o) => `- ${o.name}${o.address ? ` (${o.address})` : ""}`)
    .join("\n");
  const categories = context.categories
    .map((c) => {
      const details = [
        c.description,
        c.purpose,
        c.seats ? `${c.seats} seats` : undefined,
        c.fuel ? `${c.fuel} fuel` : undefined,
      ].filter(Boolean).join("; ");
      return `- ${c.name}${details ? `: ${details}` : ""}`;
    })
    .join("\n");

  const historyMessages = recentTurns.slice(-6).map((t) => ({
    role: t.role as "user" | "assistant",
    content: t.content,
  }));

  const llmResponse = await llmProvider.chat(
    [
      {
        role: "system",
        content: `You are a helpful SuccessVan reservation assistant.
Answer the customer's van-rental question naturally, but stay inside these facts.

Available offices:
${offices || "(none loaded)"}

Available van categories:
${categories || "(none loaded)"}

Current draft:
- Office: ${draft.officeName ?? "not set"}
- Category: ${draft.categoryName ?? "not set"}
- Pickup: ${draft.pickupDateText ?? "not set"}
- Return: ${draft.returnDateText ?? "not set"}
- Driver age: ${draft.driverAge ?? "not set"}
- Price: ${draft.pricePreview ? `£${draft.pricePreview.totalPrice.toFixed(2)}` : "not calculated"}

Rules:
- Be concise and phone-friendly.
- Use AI reasoning to answer suitability, policy, timing, and clarification questions.
- Do not invent prices, availability, offices, van categories, discounts, or booking confirmation.
- Do not claim insurance, cover, email requirements, licence upload, or add-on availability unless it appears in the provided facts. If asked about insurance and it is not listed, say the booking team can confirm insurance/cover details.
- If price is not calculated, say what detail is missing instead of guessing.
- Ask at most one question.
- If a continuation question is provided, finish with it.`,
      },
      ...historyMessages,
      {
        role: "user",
        content:
          `Customer: "${userMessage}"\n` +
          `Continuation question: ${continuationQuestion ?? "(none)"}`,
      },
    ],
    {
      model: env.OPENAI_RESPONSE_MODEL,
      maxTokens: 180,
      temperature: 0.2,
    }
  );

  return { reply: llmResponse.content.trim(), llmResponse };
}
