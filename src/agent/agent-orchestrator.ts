import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { openai } from "../ai/openai.client.js";
import { getBookingContext } from "../context/booking-context.service.js";
import { resolveEntities } from "./entity-resolver.service.js";
import { mergeBookingDraft, getMissingBookingFields } from "./booking-draft.service.js";
import { getQuestionForField, buildConfirmationMessage } from "./booking-question.service.js";
import { sttService } from "../voice/stt.service.js";
import { LatencyTracker } from "../voice/latency-tracker.js";
import type { VoiceSession } from "../sessions/voice-session.types.js";
import type { BookingDraft, BookingAgentResult } from "./types/booking.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// AI extraction schema
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fields that the AI extractor is responsible for.
 *
 * The deterministic resolver (entity-resolver.service.ts) handles offices and
 * categories. GPT only handles the fields that are genuinely hard to parse
 * deterministically: free-form dates, ages, names, phone numbers.
 *
 * We still allow GPT to fill officeId/categoryId as a fallback if the resolver
 * found nothing — GPT may succeed on unusual phrasings the alias table misses.
 */
const AiExtractedSchema = z.object({
  startDateText: z.string().optional(),
  endDateText: z.string().optional(),
  driverAge: z.number().optional(),
  selectedGear: z.enum(["manual", "automatic"]).optional(),
  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
  // Resolver fallbacks — GPT only fills these if resolver found nothing
  officeId: z.string().optional(),
  officeName: z.string().optional(),
  categoryId: z.string().optional(),
  categoryName: z.string().optional(),
});

type AiExtractedData = z.infer<typeof AiExtractedSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Orchestrator result type
// ──────────────────────────────────────────────────────────────────────────────

export type OrchestratorResult = BookingAgentResult & {
  /** The transcript that was processed in this turn. */
  transcript: string;

  /** Per-phase timing for this turn. */
  metrics: Record<string, number>;

  /** Set when the resolver detected ambiguity and is asking for clarification. */
  ambiguityQuestion?: string;
};

// ──────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ──────────────────────────────────────────────────────────────────────────────

/**
 * processTranscript — the core of the agent pipeline.
 *
 * Call this after transcription completes for a turn. It returns the next
 * agent message and the updated booking draft.
 *
 * Pipeline steps:
 *   1. Load booking context (cached — cheap after first call).
 *   2. Run deterministic entity resolver (offices, categories).
 *   3. If resolver returned an ambiguity question, return it immediately
 *      without calling GPT.
 *   4. Merge resolver findings into draft.
 *   5. Run AI extractor ONLY for fields still missing (dates, age, name, phone).
 *   6. Merge AI findings into draft.
 *   7. Validate — find remaining missing fields.
 *   8. Generate next question or confirmation message.
 *
 * GPT is skipped entirely when:
 *   - All required fields are already filled (from earlier turns).
 *   - The resolver filled office + category and the only remaining fields
 *     are already present in the draft.
 */
export async function processTranscript(params: {
  transcript: string;
  session: VoiceSession;
  latency: LatencyTracker;
}): Promise<OrchestratorResult> {
  const { transcript, session, latency } = params;
  let draft = session.bookingDraft;

  // Step 1: Load context (cached)
  latency.mark("context_start");
  const context = await getBookingContext();
  latency.mark("context_end");
  latency.measure("contextLoadMs", "context_start", "context_end");

  // Step 2: Deterministic entity resolver
  latency.mark("resolver_start");
  const resolved = resolveEntities({
    transcript,
    currentDraft: draft,
    offices: context.offices,
    categories: context.categories,
  });
  latency.mark("resolver_end");
  latency.measure("resolverMs", "resolver_start", "resolver_end");

  // Step 3: Return ambiguity question immediately — do not call GPT
  if (resolved.ambiguityQuestion) {
    return {
      message: resolved.ambiguityQuestion,
      bookingDraft: draft,
      missingFields: getMissingBookingFields(draft),
      isReadyForConfirmation: false,
      transcript,
      metrics: latency.toMetrics(),
      ambiguityQuestion: resolved.ambiguityQuestion,
    };
  }

  // Step 4: Merge resolver results
  if (resolved.officeDraft) draft = mergeBookingDraft(draft, resolved.officeDraft);
  if (resolved.categoryDraft) draft = mergeBookingDraft(draft, resolved.categoryDraft);

  // Step 5: AI extraction for fields the resolver cannot handle
  const needsAi = shouldCallAi(draft);
  if (needsAi) {
    latency.mark("ai_start");
    const aiData = await runAiExtraction({ transcript, currentDraft: draft, context });
    latency.mark("ai_end");
    latency.measure("aiExtractionMs", "ai_start", "ai_end");

    draft = mergeBookingDraft(draft, aiData);
  }

  // Step 6: Validate and build response
  const missingFields = getMissingBookingFields(draft);
  const isReadyForConfirmation = missingFields.length === 0;

  const message = isReadyForConfirmation
    ? buildConfirmationMessage(draft)
    : getQuestionForField(missingFields[0]);

  return {
    message,
    bookingDraft: draft,
    missingFields,
    isReadyForConfirmation,
    transcript,
    metrics: latency.toMetrics(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// AI extraction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether to invoke GPT for this turn.
 *
 * We skip GPT when:
 *   - The only missing fields are officeId/categoryId AND the resolver
 *     already found nothing (GPT usually won't do better either, and the
 *     next turn will likely have more info).
 *   - All required fields are already filled.
 *
 * We always call GPT when date or age fields are missing, because those
 * require NLU (e.g. "tomorrow at ten" → startDateText).
 */
function shouldCallAi(draft: BookingDraft): boolean {
  const missing = getMissingBookingFields(draft);

  if (missing.length === 0) return false;

  // Always call for date / age fields — deterministic code can't parse these
  if (
    missing.includes("startDateText") ||
    missing.includes("endDateText") ||
    missing.includes("driverAge")
  ) {
    return true;
  }

  // Let GPT try office/category as fallback if resolver found nothing
  if (missing.includes("officeId") || missing.includes("categoryId")) {
    return true;
  }

  return false;
}

/**
 * GPT extraction call.
 *
 * Receives a compact context (names + IDs only, no full pricing schema)
 * to keep the prompt small and reduce latency + cost.
 *
 * GPT must not invent IDs — only use the provided lists.
 * It must not overwrite fields already in knownDraft.
 */
async function runAiExtraction(params: {
  transcript: string;
  currentDraft: BookingDraft;
  context: Awaited<ReturnType<typeof getBookingContext>>;
}): Promise<AiExtractedData> {
  const { transcript, currentDraft, context } = params;

  // Compact context — only what GPT actually needs
  const compactContext = {
    offices: context.offices.map((o) => ({ id: o.id, name: o.name })),
    categories: context.categories.map((c) => ({
      id: c.id,
      name: c.name,
      purpose: c.purpose,
    })),
    // Tell GPT what is already known so it doesn't re-extract
    knownDraft: {
      officeId: currentDraft.officeId ?? null,
      categoryId: currentDraft.categoryId ?? null,
      startDateText: currentDraft.startDateText ?? null,
      endDateText: currentDraft.endDateText ?? null,
      driverAge: currentDraft.driverAge ?? null,
    },
  };

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a booking data extractor for a van rental phone agent.

Extract ONLY the following fields from the user's message. Return a JSON object.

Fields:
  startDateText   – pickup date/time as the user said it (e.g. "tomorrow at 10am")
  endDateText     – return date/time as the user said it
  driverAge       – integer age
  selectedGear    – "manual" or "automatic"
  customerPhone   – phone number as a string
  customerName    – full name
  officeId        – must match an ID from the provided office list
  officeName      – matching office name
  categoryId      – must match an ID from the provided category list
  categoryName    – matching category name

Rules:
  - Return only fields that are clearly present in the user's message.
  - Return {} if nothing extractable is found.
  - Do NOT overwrite fields that are already set in knownDraft.
  - Do NOT invent office or category IDs — they must come from the lists.
  - Keep date/time values as the user's natural language, not ISO format.
  - Keep responses to valid JSON only. No explanation.`.trim(),
      },
      {
        role: "user",
        content: JSON.stringify({ transcript, context: compactContext }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  try {
    const parsed = JSON.parse(raw) as unknown;
    return AiExtractedSchema.parse(parsed);
  } catch {
    // If GPT returns malformed JSON or fails Zod validation, return empty
    // rather than crashing the turn. The missing fields will be asked next turn.
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Audio file processing (batch mode — current implementation)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Save audio chunks to disk, transcribe via STT, then clean up the file.
 *
 * This is the batch fallback used until streaming STT is implemented.
 * Steps:
 *   1. Concatenate all received audio chunks into one buffer.
 *   2. Write to a temp file under tmp/audio/.
 *   3. Send to OpenAI Whisper.
 *   4. Delete the temp file asynchronously.
 *   5. Return transcript text.
 *
 * Latency is measured for each sub-step and stored in the LatencyTracker.
 */
export async function transcribeAudioChunks(params: {
  chunks: Buffer[];
  mimeType: string;
  sessionId: string;
  latency: LatencyTracker;
}): Promise<string> {
  const { chunks, mimeType, sessionId, latency } = params;

  if (chunks.length === 0) {
    throw new Error("No audio chunks to transcribe");
  }

  // ── Save to disk ──
  latency.mark("audio_save_start");

  const uploadsDir = path.join(process.cwd(), "tmp", "audio");
  await fs.mkdir(uploadsDir, { recursive: true });

  const extension = mimeTypeToExtension(mimeType);
  const fileName = `${sessionId}-${Date.now()}.${extension}`;
  const filePath = path.join(uploadsDir, fileName);

  await fs.writeFile(filePath, Buffer.concat(chunks));

  latency.mark("audio_save_end");
  latency.measure("audioSaveMs", "audio_save_start", "audio_save_end");

  // ── Transcribe ──
  latency.mark("transcription_start");
  const transcript = await sttService.transcribeFile(filePath);
  latency.mark("transcription_end");
  latency.measure("transcriptionMs", "transcription_start", "transcription_end");

  // ── Clean up temp file (non-blocking) ──
  // We don't await this — if it fails it's a non-critical disk cleanup issue.
  fs.unlink(filePath).catch(() => {});

  return transcript;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp4")) return "mp4";
  return "webm";
}
