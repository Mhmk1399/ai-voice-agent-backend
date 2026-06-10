import type { FastifyInstance } from "fastify";
import { runAgentTurn } from "../engine/run-agent-turn.js";

// ─────────────────────────────────────────────────────────────────────────────
// WS /voice/web
// Browser WebSocket voice channel.
// Receives audio chunks (base64) → STT → engine → TTS → sends back audio.
//
// For now: accepts text messages for engine testing without STT/TTS.
// Voice STT/TTS can be wired in as a channel adapter without changing the engine.
// ─────────────────────────────────────────────────────────────────────────────

interface WsMessage {
  type: "text" | "audio";
  sessionId?: string;
  content: string; // text or base64 audio
}

export async function webVoiceRoute(app: FastifyInstance): Promise<void> {
  app.get(
    "/voice/web",
    { websocket: true },
    (socket, _req) => {
      let sessionId: string | undefined;

      socket.on("message", async (raw: Buffer | string) => {
        let payload: WsMessage;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          socket.send(
            JSON.stringify({ type: "error", message: "Invalid JSON" })
          );
          return;
        }

        // Update session ID if provided
        if (payload.sessionId) sessionId = payload.sessionId;

        if (payload.type === "text") {
          try {
            const result = await runAgentTurn({
              sessionId,
              message: payload.content,
              channel: "voice",
            });
            sessionId = result.sessionId;
            socket.send(
              JSON.stringify({
                type: "reply",
                sessionId: result.sessionId,
                text: result.reply,
                workflowStep: result.workflowStep,
                missingFields: result.missingFields,
                bookingDraft: result.bookingDraft,
              })
            );
          } catch (err) {
            socket.send(
              JSON.stringify({
                type: "error",
                message: err instanceof Error ? err.message : "Agent error",
              })
            );
          }
        } else if (payload.type === "audio") {
          // Future: decode base64 → STT → runAgentTurn → TTS → send back
          socket.send(
            JSON.stringify({
              type: "info",
              message:
                "Audio channel not yet implemented. Send type: 'text' for engine testing.",
            })
          );
        }
      });

      socket.on("close", () => {
        // Clean-up if needed
      });
    }
  );
}
