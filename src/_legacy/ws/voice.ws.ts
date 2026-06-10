import type { FastifyInstance } from "fastify";
import { voiceSessionManager } from "../sessions/voice-session.manager.js";
import {
  transcribeAudioChunks,
  processTranscript,
} from "../agent/agent-orchestrator.js";
import { streamSpeech } from "../voice/tts.service.js";
import { LatencyTracker } from "../voice/latency-tracker.js";
import type { BookingDraft } from "../agent/types/booking.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Protocol types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Messages sent FROM the browser TO the server.
 *
 * Conversation flow:
 *   1. Connection opens  → server sends `session_created`
 *   2. User presses mic  → browser sends `start_turn`
 *   3. User speaks       → browser sends `audio_chunk` (many)
 *   4. User releases mic → browser sends `end_turn`
 *   5. Server processes and responds
 *   6. Repeat from step 2 for next utterance
 *   7. Booking confirmed → browser sends `end_session`
 */
type ClientMessage =
  | { type: "start_turn" }
  | { type: "audio_chunk"; audioBase64: string; mimeType: string; sequence: number }
  | { type: "end_turn" }
  | { type: "end_session" }
  /**
   * User started speaking while TTS is playing (barge-in).
   * Server cancels the active TTS stream and acknowledges.
   * Client auto-starts a new recording turn on receiving `barge_in_ack`.
   */
  | { type: "barge_in" };

/**
 * Messages sent FROM the server TO the browser.
 *
 * The browser should handle all message types and can safely ignore unknown ones.
 */
type ServerMessage =
  | { type: "session_created"; sessionId: string }
  | { type: "turn_started"; sessionId: string; turnId: string }
  | { type: "audio_chunk_received"; sequence: number; bytes: number }
  | { type: "transcription_started"; sessionId: string; turnId: string }
  | { type: "transcript_final"; sessionId: string; turnId: string; transcript: string }
  | { type: "agent_started"; sessionId: string; turnId: string }
  | {
      type: "agent_response";
      sessionId: string;
      turnId: string;
      message: string;
      bookingDraft: BookingDraft;
      missingFields: string[];
      isReadyForConfirmation: boolean;
    }
  | { type: "latency"; sessionId: string; turnId: string; metrics: Record<string, number> }
  /**
   * One PCM audio chunk from the TTS stream.
   * Format: 16-bit signed int, little-endian, mono, 24 000 Hz.
   * The client decodes the base64 string to Int16Array, converts to Float32,
   * and schedules it on a Web Audio API AudioBufferSourceNode.
   * Chunks are sent in order (index 0, 1, 2 …) and must be played in order.
   */
  | {
      type: "tts_chunk";
      sessionId: string;
      turnId: string;
      index: number;
      dataBase64: string;
      /** Always 24000 — declared here so the client never has to hard-code it. */
      sampleRate: 24000;
      channels: 1;
      encoding: "pcm_s16le";
    }
  /** All TTS chunks for this turn have been sent. */
  | { type: "tts_done"; sessionId: string; turnId: string }
  /** Server confirmed the barge-in; client should immediately send start_turn. */
  | { type: "barge_in_ack"; sessionId: string }
  | { type: "error"; message: string; details?: unknown };

// ──────────────────────────────────────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────────────────────────────────────

/** Serialise and send a typed server message. */
function send(
  socket: { send(data: string): void },
  message: ServerMessage
): void {
  socket.send(JSON.stringify(message));
}

// ──────────────────────────────────────────────────────────────────────────────
// Browser WebSocket route  (/voice/web)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Browser voice WebSocket route.
 *
 * One persistent WebSocket connection = one booking conversation.
 * Multiple turns happen on the SAME connection. Session state persists across
 * turns via VoiceSessionManager (and will persist across reconnects once we
 * add a `resume_session` message type with a client-stored sessionId).
 *
 * Turn lifecycle (per user utterance):
 *   client → `start_turn`        server → `turn_started`
 *   client → `audio_chunk` ×N    server → `audio_chunk_received` (per chunk ack)
 *   client → `end_turn`          server → pipeline runs:
 *                                           `transcription_started`
 *                                           `transcript_final`
 *                                           `agent_started`
 *                                           `agent_response`
 *                                           `tts_audio`
 *                                           `latency`
 */
export async function voiceWebWsRoute(app: FastifyInstance) {
  app.get("/voice/web", { websocket: true }, async (socket) => {
    // Create a new session for this connection.
    // The session survives the WebSocket lifetime in the session store.
    const session = await voiceSessionManager.createSession();
    const { sessionId } = session;

    app.log.info({ sessionId }, "Voice WebSocket connected — session created");

    send(socket, { type: "session_created", sessionId });

    // ── TTS cancellation token ─────────────────────────────────────────────
    // This object is shared between handleEndTurn (which streams TTS) and
    // handleBargeIn (which sets .aborted to stop the stream).
    // A new object is created at the start of each TTS generation so that a
    // stale barge-in from a previous turn doesn't bleed into the next one.
    let ttsCancel: { aborted: boolean } = { aborted: false };

    // ── Message handler ────────────────────────────────────────────────────

    // Fastify WebSocket wraps ws.WebSocket. Messages arrive as Buffer or string.
    socket.on("message", async (rawMessage: Buffer | string) => {
      let message: ClientMessage;

      try {
        const text =
          typeof rawMessage === "string"
            ? rawMessage
            : rawMessage.toString("utf8");
        message = JSON.parse(text) as ClientMessage;
      } catch {
        send(socket, { type: "error", message: "Invalid JSON message" });
        return;
      }

      try {
        await dispatch(message);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ sessionId, error: msg }, "Unhandled error in message handler");
        send(socket, {
          type: "error",
          message: "Internal server error",
          details: { message: msg },
        });
      }
    });

    // ── Close handler ──────────────────────────────────────────────────────

    socket.on("close", () => {
      app.log.info({ sessionId }, "Voice WebSocket disconnected");
      // We do NOT delete the session on close.
      // The session stays alive in the store until the TTL expires (30 min).
      // This means if the browser page refreshes mid-call, the draft is kept.
      //
      // Future: add `resume_session` message type so the client can pass
      // its stored sessionId on reconnect and continue the same conversation.
    });

    // ── Message dispatcher ────────────────────────────────────────────────

    async function dispatch(message: ClientMessage): Promise<void> {
      switch (message.type) {
        case "start_turn":
          return handleStartTurn();
        case "audio_chunk":
          return handleAudioChunk(message);
        case "end_turn":
          return handleEndTurn();
        case "end_session":
          return handleEndSession();
        case "barge_in":
          return handleBargeIn();
        default: {
          // Exhaustiveness check — TypeScript will warn if a case is missed
          const _exhaustive: never = message;
          send(socket, {
            type: "error",
            message: `Unknown message type: ${(_exhaustive as ClientMessage).type}`,
          });
        }
      }
    }

    // ── start_turn ─────────────────────────────────────────────────────────

    /**
     * Begin a new recording turn.
     * Does NOT reset the conversation — bookingDraft is preserved.
     * Only creates a new turnId and allocates a fresh audio buffer.
     */
    async function handleStartTurn(): Promise<void> {
      const current = await voiceSessionManager.getSession(sessionId);

      if (!current) {
        send(socket, {
          type: "error",
          message: "Session expired. Please refresh and start again.",
        });
        return;
      }

      const turnId = await voiceSessionManager.beginTurn(current);
      app.log.info({ sessionId, turnId }, "Turn started");

      send(socket, { type: "turn_started", sessionId, turnId });
    }

    // ── audio_chunk ────────────────────────────────────────────────────────

    /**
     * Receive one audio chunk and append it to the turn buffer.
     * Sends an ack with byte count so the client can track progress.
     */
    function handleAudioChunk(
      message: Extract<ClientMessage, { type: "audio_chunk" }>
    ): void {
      const audioBuffer = Buffer.from(message.audioBase64, "base64");
      voiceSessionManager.addChunk(sessionId, audioBuffer, message.mimeType);

      app.log.debug(
        { sessionId, sequence: message.sequence, bytes: audioBuffer.length },
        "Audio chunk received"
      );

      send(socket, {
        type: "audio_chunk_received",
        sequence: message.sequence,
        bytes: audioBuffer.length,
      });
    }

    // ── end_turn ───────────────────────────────────────────────────────────

    /**
     * User stopped speaking. Run the full pipeline:
     *   audio → transcription → entity resolver → AI extraction → response → TTS
     *
     * This does NOT end the session. The next `start_turn` continues the
     * same conversation with the same bookingDraft.
     */
    async function handleEndTurn(): Promise<void> {
      const latency = new LatencyTracker();
      latency.mark("turn_start");

      const current = await voiceSessionManager.getSession(sessionId);

      if (!current || !current.currentTurnId) {
        send(socket, {
          type: "error",
          message: "No active turn. Send start_turn before end_turn.",
        });
        return;
      }

      const turnId = current.currentTurnId;
      const { chunks, mimeType } = voiceSessionManager.consumeChunks(sessionId);

      if (chunks.length === 0) {
        send(socket, {
          type: "error",
          message: "No audio received in this turn. Did you send audio_chunk messages?",
        });
        return;
      }

      app.log.info(
        { sessionId, turnId, chunkCount: chunks.length },
        "End turn — processing audio"
      );

      // ── Transcription ──────────────────────────────────────────────────

      await voiceSessionManager.setStatus(current, "transcribing");
      send(socket, { type: "transcription_started", sessionId, turnId });

      let transcript: string;
      try {
        transcript = await transcribeAudioChunks({ chunks, mimeType, sessionId, latency });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ sessionId, turnId, error: msg }, "Transcription failed");
        send(socket, {
          type: "error",
          message: "Transcription failed",
          details: { message: msg },
        });
        await voiceSessionManager.setStatus(current, "error");
        return;
      }

      app.log.info({ sessionId, turnId, transcript }, "Transcription complete");
      send(socket, { type: "transcript_final", sessionId, turnId, transcript });

      // ── Agent pipeline ─────────────────────────────────────────────────

      await voiceSessionManager.setStatus(current, "processing");
      send(socket, { type: "agent_started", sessionId, turnId });

      latency.mark("agent_start");
      const result = await processTranscript({ transcript, session: current, latency });
      latency.mark("agent_end");
      latency.measure("agentTotalMs", "agent_start", "agent_end");

      // Persist the updated booking draft into the session store
      await voiceSessionManager.updateDraft(current, result.bookingDraft);

      app.log.info(
        { sessionId, turnId, message: result.message, draft: result.bookingDraft },
        "Agent response generated"
      );

      send(socket, {
        type: "agent_response",
        sessionId,
        turnId,
        message: result.message,
        bookingDraft: result.bookingDraft,
        missingFields: result.missingFields,
        isReadyForConfirmation: result.isReadyForConfirmation,
      });

      // ── TTS streaming ──────────────────────────────────────────────────
      //
      // Why streaming?
      //   Batch mode: server waits 3–5 s for full MP3 before sending anything.
      //   Streaming:  first PCM chunk arrives at the client in ~200–400 ms.
      //               The user hears the first word while the rest generates.
      //
      // Barge-in:
      //   If the user starts speaking mid-response, handleBargeIn() sets
      //   ttsCancel.aborted = true. The stream loop exits at the next chunk
      //   boundary, cancelling the HTTP request to OpenAI to save bandwidth.

      ttsCancel = { aborted: false }; // fresh token for this turn
      latency.mark("tts_start");

      try {
        const { completed } = await streamSpeech({
          text: result.message,
          signal: ttsCancel,
          onChunk: (data, index) => {
            send(socket, {
              type: "tts_chunk",
              sessionId,
              turnId,
              index,
              dataBase64: data.toString("base64"),
              sampleRate: 24000,
              channels: 1,
              encoding: "pcm_s16le",
            });
          },
        });

        if (completed) {
          send(socket, { type: "tts_done", sessionId, turnId });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        app.log.warn({ sessionId, turnId, error: msg }, "TTS stream failed (non-fatal)");
      }

      latency.mark("tts_end");
      latency.measure("ttsMs", "tts_start", "tts_end");

      // ── Latency report ──────────────────────────────────────────────────

      latency.mark("turn_end");
      latency.measure("totalTurnMs", "turn_start", "turn_end");

      const metrics = latency.toMetrics();
      app.log.info({ sessionId, turnId, metrics }, "Turn complete — latency report");
      send(socket, { type: "latency", sessionId, turnId, metrics });

      // ── Record turn to history ──────────────────────────────────────────

      await voiceSessionManager.recordTurn(current, {
        turnId,
        userTranscript: transcript,
        agentMessage: result.message,
        metrics,
        timestamp: Date.now(),
      });
    }

    // ── barge_in ───────────────────────────────────────────────────────────

    /**
     * User started speaking while the agent TTS response is playing.
     *
     * 1. Set the cancellation flag — the streamSpeech loop exits at the next
     *    chunk boundary and cancels the OpenAI HTTP request.
     * 2. Send `barge_in_ack` so the client can immediately start a new turn
     *    without waiting for TTS to finish.
     *
     * The current turn's bookingDraft and history are preserved — barge-in
     * only interrupts the audio, not the conversation state.
     */
    function handleBargeIn(): void {
      ttsCancel.aborted = true;
      app.log.info({ sessionId }, "Barge-in received — TTS stream cancelled");
      send(socket, { type: "barge_in_ack", sessionId });
    }

    // ── end_session ────────────────────────────────────────────────────────

    /**
     * Client explicitly ends the session (e.g. user confirmed the booking,
     * or cancelled). Cleans up session state and closes the socket.
     */
    async function handleEndSession(): Promise<void> {
      app.log.info({ sessionId }, "Session ended by client");
      await voiceSessionManager.endSession(sessionId);
      socket.close(1000, "Session ended");
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Legacy route alias  (/voice/ws)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Legacy route kept for backward compatibility during the migration period.
 *
 * The old frontend connected to /voice/ws using start/stop messages.
 * The new frontend should connect to /voice/web using start_turn/end_turn.
 *
 * This shim redirects /voice/ws to the new implementation so old clients
 * still work. Remove once the frontend is fully migrated.
 *
 * @deprecated Use voiceWebWsRoute (/voice/web) instead.
 */
export async function voiceWsRoute(app: FastifyInstance) {
  // Simply register the new route handler also under the legacy path.
  // The protocol has changed (start_turn / end_turn vs start / stop).
  // Old clients will receive a `session_created` event instead of `connected`,
  // and will need updating. But the server won't crash on old messages — unknown
  // message types are handled by the exhaustive switch in dispatch().
  app.get("/voice/ws", { websocket: true }, async (socket) => {
    const session = await voiceSessionManager.createSession();
    const { sessionId } = session;

    app.log.warn(
      { sessionId },
      "Client connected to deprecated /voice/ws — please migrate to /voice/web"
    );

    // Send both old and new connected events for gradual migration
    socket.send(JSON.stringify({ type: "connected", sessionId })); // old format
    socket.send(JSON.stringify({ type: "session_created", sessionId })); // new format

    socket.on("close", () => {
      app.log.info({ sessionId }, "/voice/ws disconnected");
    });

    socket.on("message", () => {
      // Old message format (start/audio_chunk/stop) is no longer supported.
      // Send a migration hint to the client.
      socket.send(
        JSON.stringify({
          type: "error",
          message:
            "This endpoint is deprecated. Please update your client to use /voice/web with the start_turn / end_turn protocol.",
        })
      );
    });
  });
}


