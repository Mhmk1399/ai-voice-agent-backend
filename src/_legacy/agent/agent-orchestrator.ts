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
 * ── Why .nullish() and not .optional()? ─────────────────────────────────────
 * GPT sometimes returns null for fields it cannot fill, even when the schema
 * only declares them as optional. z.string().optional() only accepts
 * `string | undefined`; passing `null` throws a Zod error, which silently
 * discards the entire response (because the catch block returns {}).
 * .nullish() = string | null | undefined — it accepts whatever GPT sends.
 * mergeBookingDraft already filters out null/undefined, so null values from
 * GPT never pollute the booking draft.
 *
 * ── Why is selectedGear z.string().nullish() and not z.enum(…).nullish()? ───
 * GPT occasionally returns "not specified" or "unknown" for enum fields.
 * z.enum(["manual","automatic"]) would throw on those values, killing the
 * whole parse. We accept any string and validate/filter downstream.
 */
const AiExtractedSchema = z.object({
  startDateText: z.string().nullish(),
  endDateText: z.string().nullish(),
  driverAge: z.number().nullish(),
  selectedGear: z.string().nullish(), // validated as GearType in mergeBookingDraft
  customerPhone: z.string().nullish(),
  customerName: z.string().nullish(),
  // Resolver fallbacks — GPT only fills these if resolver found nothing
  officeId: z.string().nullish(),
  officeName: z.string().nullish(),
  categoryId: z.string().nullish(),
  categoryName: z.string().nullish(),
});

type AiExtractedData = z.infer<typeof AiExtractedSchema>;

/**
 * Safe wrapper around the Zod schema.
 * Returns whatever fields pass validation rather than throwing on the first
 * field that doesn't match (which is what .parse() does).
 */
function parseAiResponse(raw: string): AiExtractedData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  const result = AiExtractedSchema.safeParse(parsed);

  if (!result.success) {
    // Log but do not crash. Partial extraction is better than nothing.
    console.warn(
      "[agent-orchestrator] GPT response failed Zod validation:",
      JSON.stringify(result.error.issues)
    );
    // Fall back: extract known-safe string fields manually
    const obj = parsed as Record<string, unknown>;
    return {
      startDateText: typeof obj.startDateText === "string" ? obj.startDateText : undefined,
      endDateText: typeof obj.endDateText === "string" ? obj.endDateText : undefined,
      driverAge: typeof obj.driverAge === "number" ? obj.driverAge : undefined,
      customerPhone: typeof obj.customerPhone === "string" ? obj.customerPhone : undefined,
      customerName: typeof obj.customerName === "string" ? obj.customerName : undefined,
      officeId: typeof obj.officeId === "string" ? obj.officeId : undefined,
      officeName: typeof obj.officeName === "string" ? obj.officeName : undefined,
      categoryId: typeof obj.categoryId === "string" ? obj.categoryId : undefined,
      categoryName: typeof obj.categoryName === "string" ? obj.categoryName : undefined,
    };
  }

  // Coerce selectedGear: only accept the two valid values
  const gear = result.data.selectedGear;
  return {
    ...result.data,
    selectedGear: gear === "manual" || gear === "automatic" ? gear : undefined,
  };
}

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
    const aiData = await runAiExtraction({
      transcript,
      currentDraft: draft,
      context,
      // Pass recent turn history so GPT has conversation context.
      // Limit to last 4 turns to keep prompt size predictable.
      recentTurns: session.turns.slice(-4),
    });
    latency.mark("ai_end");
    latency.measure("aiExtractionMs", "ai_start", "ai_end");

    // Strip null values before merging into the draft.
    // AiExtractedData uses .nullish() so GPT can return null, but BookingDraft
    // only accepts undefined. mergeBookingDraft already skips nulls at runtime;
    // this cast satisfies TypeScript.
    const cleanAiData = Object.fromEntries(
      Object.entries(aiData).filter(([, v]) => v != null)
    ) as Partial<BookingDraft>;
    draft = mergeBookingDraft(draft, cleanAiData);
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
  recentTurns: import("../sessions/voice-session.types.js").TurnRecord[];
}): Promise<AiExtractedData> {
  const { transcript, currentDraft, context, recentTurns } = params;

  // ── Compact context ──────────────────────────────────────────────────────
  // Only send IDs + names — do NOT send full pricing/schema to GPT.
  // Keeps the prompt small = faster response + lower cost.
  const officeList = context.offices.map((o) => ({ id: o.id, name: o.name }));
  const categoryList = context.categories.map((c) => ({
    id: c.id,
    name: c.name,
    purpose: c.purpose,
  }));

  // Only include ALREADY FILLED fields in knownDraft.
  // Sending null values for unset fields confuses GPT — it sometimes returns
  // null back for those fields, which was breaking Zod validation silently.
  const knownDraft: Record<string, unknown> = {};
  if (currentDraft.officeId) knownDraft.officeId = currentDraft.officeId;
  if (currentDraft.officeName) knownDraft.officeName = currentDraft.officeName;
  if (currentDraft.categoryId) knownDraft.categoryId = currentDraft.categoryId;
  if (currentDraft.categoryName) knownDraft.categoryName = currentDraft.categoryName;
  if (currentDraft.startDateText) knownDraft.startDateText = currentDraft.startDateText;
  if (currentDraft.endDateText) knownDraft.endDateText = currentDraft.endDateText;
  if (currentDraft.driverAge) knownDraft.driverAge = currentDraft.driverAge;

  // ── Conversation history ─────────────────────────────────────────────────
  // Pass the last few user transcripts so GPT has full context.
  // E.g. if turn 1 set the office and turn 3 mentions a date, GPT should
  // understand it's still the same booking.
  const history = recentTurns.map((t) => ({
    user: t.userTranscript,
    agent: t.agentMessage,
  }));

  // ── System prompt ────────────────────────────────────────────────────────
  // Today's date is critical for resolving relative dates like "tomorrow".
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const systemPrompt = `You are a booking data extractor for a van rental phone agent.
Today is ${today}.

Your job: extract NEW booking information from the latest user message.
Do NOT repeat information already in knownDraft.

Return a JSON object with ONLY the fields you can confidently extract.
Return {} if the message contains nothing new.

Extractable fields:
  startDateText  – pickup date/time. Use the exact words the user said.
                   If they say "tomorrow at 5pm", output "tomorrow at 5pm".
                   If they say "June 7th at 3pm", output "June 7th at 3pm".
  endDateText    – return date/time. Same rule as above.
  driverAge      – integer
  selectedGear   – exactly "manual" or "automatic" (omit if not mentioned)
  customerPhone  – as spoken
  customerName   – full name
  officeId       – ID from the office list (only if not already in knownDraft)
  officeName     – matching name
  categoryId     – ID from the category list (only if not already in knownDraft)
  categoryName   – matching name

Rules:
  - NEVER output a field that is already in knownDraft.
  - NEVER output null or empty string for any field — omit the field instead.
  - Do NOT invent IDs. officeId/categoryId must come from the provided lists.
  - Do NOT convert dates to ISO format. Keep the user's natural phrasing.
  - Output valid JSON only. No explanation, no markdown.`;

  // ── Call GPT ─────────────────────────────────────────────────────────────
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          conversationHistory: history,
          latestUserMessage: transcript,
          knownDraft,
          availableOffices: officeList,
          availableCategories: categoryList,
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  // parseAiResponse uses safeParse + manual fallback — never throws
  return parseAiResponse(raw);
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
