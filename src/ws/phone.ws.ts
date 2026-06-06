import type { FastifyInstance } from "fastify";

/**
 * Phone stream WebSocket route (Twilio / SIP placeholder).
 *
 * This route will eventually accept audio streams from Twilio Media Streams
 * or a SIP gateway (e.g. Asterisk via WebSocket).
 *
 * Once implemented, it will share the same VoiceSessionManager and
 * processTranscript pipeline as the browser route (/voice/web).
 * The only difference will be:
 *   - Audio format: mu-law 8kHz (Twilio) vs WebM/Opus (browser)
 *   - Audio direction: bidirectional stream vs client push + server push
 *   - Session creation: may be triggered by incoming call webhook, not WS connect
 *
 * Implementation checklist (future):
 *   [ ] Parse Twilio `start` event to extract call SID and stream SID
 *   [ ] Convert mu-law audio chunks to PCM (use `mulaw` npm package)
 *   [ ] Feed PCM chunks to streaming STT (when SttService.startStream() exists)
 *       OR accumulate + transcribe in batch (same as browser route currently)
 *   [ ] Use voiceSessionManager.createSession() keyed to call SID
 *   [ ] Call processTranscript() with transcript
 *   [ ] Generate TTS response and send back as mu-law over the stream
 *
 * Reference:
 *   https://www.twilio.com/docs/voice/media-streams
 */
export async function phoneWsRoute(app: FastifyInstance) {
  app.get("/voice/twilio", { websocket: true }, (socket) => {
    app.log.info("Twilio phone WebSocket connected — not yet implemented");

    socket.on("message", (raw: Buffer | string) => {
      // Twilio sends JSON messages with a `event` field:
      //   { event: "start",     streamSid, start: { callSid, ... } }
      //   { event: "media",     streamSid, media: { payload: "<base64 mulaw>" } }
      //   { event: "stop",      streamSid }
      app.log.debug({ raw: raw.toString() }, "Twilio message (stub — not processed)");

      socket.send(
        JSON.stringify({
          type: "info",
          message: "Phone stream endpoint is not yet implemented.",
        })
      );
    });

    socket.on("close", () => {
      app.log.info("Twilio phone WebSocket disconnected");
    });
  });
}
