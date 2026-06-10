import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { voiceSessionManager } from "../sessions/voice-session.manager.js";
import { processTranscript } from "../agent/agent-orchestrator.js";
import { LatencyTracker } from "../voice/latency-tracker.js";

// ──────────────────────────────────────────────────────────────────────────────
// Booking Tool Routes
//
// These HTTP routes are the backend half of the WebRTC Realtime architecture.
//
// In the Realtime flow, booking logic is intentionally NOT inside the AI model.
// The model only handles conversation; it calls tools for anything booking-related.
//
//   OpenAI (in browser)
//     │
//     │  tool_call: process_booking_turn({ sessionId, transcript })
//     ▼
//   Browser JS
//     │
//     │  POST /tools/process-booking-turn   ◄──── This file
//     ▼
//   Our Backend (agent-orchestrator.ts, session store, MongoDB)
//     │
//     │  { message, bookingDraft, missingFields, isReadyForConfirmation }
//     ▼
//   Browser JS  →  sends tool result back to OpenAI data channel
//     ▼
//   OpenAI speaks the returned message aloud to the user
//
// Why keep booking logic in the backend?
//   - Rules and field validation change frequently; redeploying backend is safe.
//   - Session state (bookingDraft) must be server-side for multi-turn consistency.
//   - Prevents the AI from hallucinating prices, availability, or office details.
//   - The same tool endpoint works for both WebRTC (browser) and future
//     Twilio/SIP (server-side Realtime bridge).
// ──────────────────────────────────────────────────────────────────────────────

const ProcessBookingTurnBodySchema = z.object({
  /**
   * The booking session ID from a previous call.
   * Omit on the very first turn — a new session will be created automatically.
   * The returned `sessionId` must be passed back on all subsequent turns for
   * the same conversation.
   */
  sessionId: z.string().optional(),

  /**
   * Exact transcript of what the user said in this turn.
   * In the WebRTC flow, this comes from OpenAI's transcript event.
   * Can also be used for testing with a typed string.
   */
  transcript: z.string().min(1),
});

type ProcessBookingTurnBody = z.infer<typeof ProcessBookingTurnBodySchema>;

export async function bookingToolsRoute(app: FastifyInstance) {
  /**
   * POST /tools/process-booking-turn
   *
   * Runs one turn of the booking pipeline: entity resolver + AI extraction +
   * response generation. Stateless from the caller's perspective — all state
   * is maintained in VoiceSessionManager keyed by sessionId.
   *
   * Called by:
   *   - Browser WebRTC client when OpenAI fires a process_booking_turn tool_call.
   *   - Future Twilio/SIP bridge (same endpoint, different caller).
   *   - Direct API callers / testing tools.
   *
   * Request:
   *   { sessionId?: string, transcript: string }
   *
   * Response:
   *   {
   *     sessionId: string,          // pass this back on every subsequent call
   *     message: string,            // speak this to the user
   *     bookingDraft: BookingDraft,
   *     missingFields: string[],
   *     isReadyForConfirmation: boolean,
   *     metrics: Record<string, number>
   *   }
   */
  app.post<{ Body: ProcessBookingTurnBody }>(
    "/tools/process-booking-turn",
    {
      schema: {
        body: {
          type: "object",
          required: ["transcript"],
          properties: {
            sessionId: { type: "string" },
            transcript: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      // ── Parse & validate body ────────────────────────────────────────────

      const parseResult = ProcessBookingTurnBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.flatten(),
        });
      }

      const { sessionId: incomingSessionId, transcript } = parseResult.data;

      // ── Load or create session ───────────────────────────────────────────

      const session = await voiceSessionManager.getOrCreateSession(incomingSessionId);
      const { sessionId } = session;

      app.log.info(
        { sessionId, transcript: transcript.slice(0, 80) },
        "process-booking-turn called"
      );

      // ── Run agent pipeline ───────────────────────────────────────────────

      const latency = new LatencyTracker();
      latency.mark("turn_start");

      let result;
      try {
        result = await processTranscript({ transcript, session, latency });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ sessionId, error: msg }, "processTranscript failed");
        return reply.code(500).send({
          error: "Agent pipeline failed",
          details: msg,
        });
      }

      latency.mark("turn_end");
      latency.measure("totalTurnMs", "turn_start", "turn_end");

      // ── Persist updated draft ────────────────────────────────────────────

      await voiceSessionManager.updateDraft(session, result.bookingDraft);

      // Record the turn in session history
      await voiceSessionManager.recordTurn(session, {
        turnId: `tool-${Date.now()}`,
        userTranscript: transcript,
        agentMessage: result.message,
        metrics: latency.toMetrics(),
        timestamp: Date.now(),
      });

      app.log.info(
        {
          sessionId,
          message: result.message,
          missingFields: result.missingFields,
          isReadyForConfirmation: result.isReadyForConfirmation,
        },
        "process-booking-turn complete"
      );

      // ── Return result ────────────────────────────────────────────────────

      return reply.code(200).send({
        /**
         * Always return sessionId so the frontend can pass it back on the
         * next turn without having to store it separately.
         */
        sessionId,
        /** Speak this message to the user via the Realtime assistant output. */
        message: result.message,
        bookingDraft: result.bookingDraft,
        missingFields: result.missingFields,
        isReadyForConfirmation: result.isReadyForConfirmation,
        metrics: latency.toMetrics(),
      });
    }
  );
}
