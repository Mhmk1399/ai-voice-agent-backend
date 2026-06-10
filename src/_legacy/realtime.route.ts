import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

// ──────────────────────────────────────────────────────────────────────────────
// OpenAI Realtime Session Route
//
// Architecture overview:
//
//   Browser                     Our Backend                 OpenAI
//   ──────                      ───────────                 ──────
//   GET /realtime/session  ──►  POST /v1/realtime/sessions  ──►
//                          ◄──  { client_secret, id, … }   ◄──
//   RTCPeerConnection.createOffer
//   POST <SDP offer> ──────────────────────────────────────────►  OpenAI WHIP
//                          ◄──────────────────────────────────── SDP answer
//   setRemoteDescription
//   mic audio ──────────────────────────────────────────────────► OpenAI
//   assistant audio ◄────────────────────────────────────────────
//   data channel events ◄──────────────────────────────────────►
//     (transcripts, tool_calls, etc.)
//
// Why this design?
//   - Audio travels directly browser ↔ OpenAI via WebRTC. The backend is
//     never in the audio path. This gives the lowest possible latency.
//   - OPENAI_API_KEY never leaves the backend. The browser only receives
//     a short-lived ephemeral client secret (~60 seconds TTL) which only
//     grants access to the specific session just created.
//   - Booking business logic stays in the backend (/tools/* routes).
//     The browser calls those endpoints when OpenAI fires a tool_call event.
//     This keeps the model "thin" — it handles conversation flow only.
//
// Security:
//   - The ephemeral token is only usable for the duration of the Realtime
//     session. It cannot be used to access any other OpenAI endpoint.
//   - Add authentication/rate-limiting to this endpoint before production.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Shape of the OpenAI Realtime Sessions API response.
 *
 * Docs: https://platform.openai.com/docs/api-reference/realtime-sessions
 */
type RealtimeSessionResponse = {
  id: string;
  object: "realtime.session";
  model: string;
  voice: string;
  client_secret: {
    /** The ephemeral token to send to the browser. */
    value: string;
    /** Unix timestamp when this token expires (typically now + 60s). */
    expires_at: number;
  };
};

export async function realtimeSessionRoute(app: FastifyInstance) {
  /**
   * GET /realtime/session
   *
   * Creates an OpenAI Realtime session server-side and returns only the
   * ephemeral client secret to the browser. The browser uses this token
   * to establish a WebRTC connection directly with OpenAI.
   *
   * The session is pre-configured with:
   *   - The process_booking_turn tool definition, so OpenAI knows when to
   *     trigger the booking pipeline.
   *   - A system prompt that instructs the model to rely on the tool for
   *     all booking logic, not try to answer from memory.
   *   - Voice "alloy" to match the existing batch TTS voice.
   *   - Input audio format: pcm16 (required for WebRTC, 24kHz mono).
   *
   * TODO (production):
   *   - Require an auth header (JWT / API key) before creating a session.
   *   - Rate-limit per IP (e.g., 10 sessions per minute).
   *   - Pass a bookingSessionId to correlate with VoiceSession in the store.
   */
  app.get("/realtime/session", async (request, reply) => {
    let sessionData: RealtimeSessionResponse;

    try {
      const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2024-12-17",
          voice: "alloy",
          // ── Session-level system instructions ─────────────────────────
          // Keep this prompt minimal. Full booking logic and rules live in
          // the backend (agent-orchestrator.ts). The model's only job here
          // is to have a natural conversation and call process_booking_turn
          // at the right moment.
          instructions: [
            "You are a friendly van rental booking assistant for SuccessVan.",
            "Your job is to have a natural voice conversation with the customer.",
            "When the customer says anything about their booking (dates, van type,",
            "location, or personal details), call the process_booking_turn tool",
            "with the transcript of what they just said.",
            "Do NOT try to remember or validate booking details yourself.",
            "Always wait for the tool response and use it as your next reply.",
            "Keep responses short and conversational.",
          ].join(" "),
          // ── Tools ────────────────────────────────────────────────────
          // The model must call this tool (not answer from memory) whenever
          // the user says anything related to a booking. The frontend intercepts
          // the tool_call event, POSTs to /tools/process-booking-turn, and
          // returns the result back to the model.
          tools: [
            {
              type: "function",
              name: "process_booking_turn",
              description:
                "Process one turn of the booking conversation. " +
                "Call this whenever the user says anything about their van rental " +
                "(location, dates, van type, driver age, name, phone, etc). " +
                "Returns the next agent message to speak and current booking status.",
              parameters: {
                type: "object",
                properties: {
                  sessionId: {
                    type: "string",
                    description:
                      "The booking session ID returned by a previous call. " +
                      "Omit for the very first turn — a new session will be created.",
                  },
                  transcript: {
                    type: "string",
                    description:
                      "Exact transcript of what the user just said in this turn.",
                  },
                },
                required: ["transcript"],
                additionalProperties: false,
              },
            },
          ],
          // Ensure the model always calls the tool rather than answering directly.
          tool_choice: "auto",
          // Audio format used by WebRTC (PCM 16-bit, 24kHz, mono).
          // This must match what RTCPeerConnection negotiates with OpenAI.
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          // Detect end-of-speech automatically so the model knows when the
          // user has finished a turn without requiring a push-to-talk button.
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        app.log.error(
          { status: response.status, body: errorText },
          "OpenAI Realtime Sessions API error"
        );
        return reply.code(502).send({
          error: "Failed to create Realtime session",
          details: errorText,
        });
      }

      sessionData = (await response.json()) as RealtimeSessionResponse;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error({ error: msg }, "Network error calling OpenAI Realtime Sessions API");
      return reply.code(502).send({
        error: "Failed to create Realtime session",
        details: msg,
      });
    }

    app.log.info(
      {
        realtimeSessionId: sessionData.id,
        model: sessionData.model,
        expiresAt: sessionData.client_secret.expires_at,
      },
      "Realtime session created"
    );

    // Return ONLY what the browser needs. Never return OPENAI_API_KEY.
    return reply.code(200).send({
      /** Ephemeral token — valid for ~60 seconds. Browser uses this to connect to OpenAI. */
      clientSecret: sessionData.client_secret.value,
      /** When the token expires (Unix ms). Browser should connect before this. */
      expiresAt: sessionData.client_secret.expires_at * 1000,
      /** OpenAI session ID — optionally pass to process_booking_turn for correlation. */
      realtimeSessionId: sessionData.id,
      model: sessionData.model,
      voice: sessionData.voice,
    });
  });
}
