import type { FastifyInstance } from "fastify";

// ──────────────────────────────────────────────────────────────────────────────
// Phone Stream WebSocket Route — Twilio / SIP
//
// ── Why this route is different from /voice/web ─────────────────────────────
//
// Browser clients (/voice/web or WebRTC) can use modern audio formats (WebM,
// Opus, PCM 24kHz) and can connect to OpenAI directly via WebRTC. Phone calls
// cannot — they go through a telco infrastructure that uses:
//   - μ-law (G.711) audio at 8kHz mono
//   - WebSocket delivery via Twilio Media Streams
//
// This route must act as a server-side bridge:
//
//   Twilio        Our Backend              OpenAI
//   ──────        ───────────              ──────
//   WS connect ──► /voice/twilio
//   media (μ-law) ──► decode ─────────────────────► Realtime API (WebSocket)
//                          ◄─────────────────────── audio (24kHz PCM)
//   encode (μ-law) ◄───────
//   play to caller ◄───────
//
// Unlike the browser path (WebRTC), the audio here goes THROUGH our backend.
// There is no way to avoid this for Twilio — we must be in the audio path.
//
// ── Implementation checklist ─────────────────────────────────────────────────
//
// TODO(phone): Parse Twilio start event
//   Twilio sends: { event: "start", streamSid, start: { callSid, accountSid, … } }
//   Extract callSid → use as sessionId key in VoiceSessionManager.
//
// TODO(phone): Convert μ-law 8kHz → PCM 24kHz for OpenAI
//   Twilio media chunks: { event: "media", media: { payload: "<base64 mulaw>" } }
//   Steps:
//     1. Base64-decode the payload to a Buffer.
//     2. Decode μ-law to 16-bit signed PCM 8kHz using the `mulaw` npm package.
//        Or decode manually: https://en.wikipedia.org/wiki/G.711#μ-law
//     3. Upsample from 8kHz to 24kHz (linear or polyphase interpolation).
//        The `sox` CLI, `@alexanderolsen/libsamplerate-js`, or a simple
//        linear interpolation loop all work.
//   The resulting buffer is raw PCM s16le at 24kHz mono — exactly what
//   OpenAI Realtime's input_audio_format="pcm16" expects.
//
// TODO(phone): Open server-side OpenAI Realtime WebSocket
//   Browser uses WebRTC (WHIP). Server-to-server must use WebSocket instead:
//     const ws = new WebSocket(
//       "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
//       {
//         headers: {
//           Authorization: `Bearer ${env.OPENAI_API_KEY}`,
//           "OpenAI-Beta": "realtime=v1",
//         },
//       }
//     );
//   One WebSocket per active phone call. Must be kept alive for the call duration.
//   Use session.update to inject the same tools configuration as /realtime/session.
//
// TODO(phone): Stream PCM audio to OpenAI
//   After converting μ-law → PCM 24kHz, send via:
//     ws.send(JSON.stringify({
//       type: "input_audio_buffer.append",
//       audio: base64PcmChunk,
//     }));
//   OpenAI's server_vad will detect speech start/end automatically.
//
// TODO(phone): Handle OpenAI tool calls server-side
//   The browser calls /tools/process-booking-turn when OpenAI fires a tool_call.
//   Here, the backend must do the same thing itself:
//     const result = await processTranscript({ transcript, session, latency });
//   Then send the result back to OpenAI as a function_call_output event.
//
// TODO(phone): Convert PCM 24kHz → μ-law 8kHz for Twilio
//   OpenAI sends: { type: "response.audio.delta", delta: "<base64 pcm 24kHz>" }
//   Reverse of the input conversion:
//     1. Decode base64 → raw PCM 24kHz s16le.
//     2. Downsample 24kHz → 8kHz.
//     3. Encode to μ-law.
//     4. Base64-encode and send back to Twilio as a media event:
//        { event: "media", streamSid, media: { payload: "<base64 mulaw>" } }
//
// TODO(phone): Handle barge-in for phone calls
//   Twilio's VAD is not as good as OpenAI's. Options:
//     a) Rely entirely on OpenAI server_vad (send all audio, let it decide).
//     b) Add client-side energy detection and send input_audio_buffer.clear
//        + response.cancel when energy exceeds threshold while assistant speaks.
//   Option (a) is simpler and usually good enough for booking flows.
//
// TODO(phone): Session cleanup on call end
//   Twilio sends: { event: "stop", streamSid }
//   Close the OpenAI WebSocket and call voiceSessionManager.endSession(callSid).
//
// ── Useful references ────────────────────────────────────────────────────────
//   Twilio Media Streams: https://www.twilio.com/docs/voice/media-streams
//   OpenAI Realtime (WebSocket): https://platform.openai.com/docs/guides/realtime-webrtc
//   μ-law decoding: https://en.wikipedia.org/wiki/G.711
//   npm mulaw package: https://www.npmjs.com/package/mulaw
// ──────────────────────────────────────────────────────────────────────────────

export async function phoneWsRoute(app: FastifyInstance) {
  app.get("/voice/twilio", { websocket: true }, (socket) => {
    app.log.info("Twilio phone WebSocket connected — not yet implemented");

    socket.on("message", (raw: Buffer | string) => {
      // Twilio sends JSON messages with an `event` field:
      //   { event: "start",     streamSid, start: { callSid, … } }
      //   { event: "media",     streamSid, media: { payload: "<base64 mulaw>" } }
      //   { event: "stop",      streamSid }
      //   { event: "dtmf",      streamSid, dtmf: { digit } }          (optional)
      app.log.debug({ raw: raw.toString() }, "Twilio message (stub — not processed)");

      socket.send(
        JSON.stringify({
          type: "info",
          message:
            "Phone stream endpoint is not yet implemented. " +
            "See src/ws/phone.ws.ts for the full implementation checklist.",
        })
      );
    });

    socket.on("close", () => {
      app.log.info("Twilio phone WebSocket disconnected");
    });
  });
}

