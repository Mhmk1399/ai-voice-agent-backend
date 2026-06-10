/**
 * SuccessVan — WebRTC Realtime Browser Client Example
 *
 * This file shows the complete browser-side flow for the low-latency
 * WebRTC voice booking experience.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *                     ┌─────────────────────────────────────┐
 *                     │            Browser                  │
 *  Microphone ────────►                                     ├──────► OpenAI
 *                     │  RTCPeerConnection  ◄── audio ──────┤◄────── Speaker
 *                     │  DataChannel        ◄── events ─────┤
 *                     │                                     │
 *                     │  fetch(/tools/process-booking-turn) ├──────► Backend
 *                     │                              ◄──────┤◄───────
 *                     └─────────────────────────────────────┘
 *
 * Flow:
 *   1.  Browser calls GET /realtime/session on our backend.
 *       Backend creates an OpenAI Realtime session server-side and returns
 *       only an ephemeral clientSecret (~60 second TTL). OPENAI_API_KEY
 *       never reaches the browser.
 *
 *   2.  Browser creates an RTCPeerConnection, adds the microphone track, and
 *       creates a data channel named "oai-events" for Realtime API events.
 *
 *   3.  Browser creates an SDP offer and POSTs it to OpenAI's WHIP endpoint
 *       (https://api.openai.com/v1/realtime) with the ephemeral token.
 *       OpenAI returns an SDP answer. Browser sets the remote description.
 *
 *   4.  WebRTC connection is established. From this point:
 *       - Microphone audio flows directly browser → OpenAI (no backend hop).
 *       - Assistant audio flows directly OpenAI → browser speaker.
 *       - Latency for the audio path is determined by WebRTC, not HTTP.
 *
 *   5.  OpenAI's server-side VAD detects end-of-speech and fires a
 *       "conversation.item.input_audio_transcription.completed" event.
 *
 *   6.  OpenAI decides to call the "process_booking_turn" tool and fires a
 *       "response.function_call_arguments.done" event with the transcript.
 *
 *   7.  Browser calls POST /tools/process-booking-turn on our backend.
 *       Backend runs: entity resolver → GPT extraction → response generation.
 *       Returns: { sessionId, message, bookingDraft, missingFields, … }
 *
 *   8.  Browser sends the tool result back to OpenAI via the data channel.
 *       OpenAI speaks the `message` field aloud to the user.
 *
 *   9.  Barge-in: if the user speaks while the assistant is playing audio,
 *       browser sends a "response.cancel" event and OpenAI stops immediately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is a plain TypeScript/JavaScript module. Copy the functions into your
 * Next.js "use client" component or any browser JS entry point.
 *
 * Prerequisites:
 *   - Backend running on http://localhost:4010
 *   - No npm packages required (uses browser-native WebRTC + fetch APIs)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────────

const BACKEND_URL = "http://localhost:4010";
const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

/** Response from GET /realtime/session */
type SessionTokenResponse = {
  clientSecret: string;
  expiresAt: number;     // Unix ms
  realtimeSessionId: string;
  model: string;
  voice: string;
};

/** Response from POST /tools/process-booking-turn */
type BookingTurnResponse = {
  sessionId: string;
  message: string;
  bookingDraft: Record<string, unknown>;
  missingFields: string[];
  isReadyForConfirmation: boolean;
  metrics: Record<string, number>;
};

/**
 * Realtime API data channel event (subset of the full schema).
 * Full schema: https://platform.openai.com/docs/api-reference/realtime-client-events
 */
type RealtimeEvent = {
  type: string;
  event_id?: string;
  [key: string]: unknown;
};

// ──────────────────────────────────────────────────────────────────────────────
// Step 1 — Fetch ephemeral token from our backend
// ──────────────────────────────────────────────────────────────────────────────

async function fetchEphemeralToken(): Promise<SessionTokenResponse> {
  const response = await fetch(`${BACKEND_URL}/realtime/session`);

  if (!response.ok) {
    throw new Error(
      `Failed to get Realtime session: ${response.status} ${await response.text()}`
    );
  }

  return response.json() as Promise<SessionTokenResponse>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 2–3 — Create WebRTC connection and negotiate with OpenAI
// ──────────────────────────────────────────────────────────────────────────────

type RealtimeConnection = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** Stop the session: close the PeerConnection and release the mic. */
  close: () => void;
};

async function createRealtimeConnection(
  clientSecret: string,
  onEvent: (event: RealtimeEvent) => void
): Promise<RealtimeConnection> {
  // ── Acquire microphone ─────────────────────────────────────────────────────
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Echo cancellation prevents the assistant's audio from looping back
      // into the mic and triggering false voice activity detection.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  // ── RTCPeerConnection ──────────────────────────────────────────────────────
  const pc = new RTCPeerConnection();

  // Add microphone track. Audio flows directly to OpenAI via SRTP.
  for (const track of micStream.getAudioTracks()) {
    pc.addTrack(track, micStream);
  }

  // Receive assistant audio. Attach to an AudioElement so it plays immediately.
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  pc.ontrack = (evt) => {
    audioEl.srcObject = evt.streams[0];
  };

  // ── Data channel ───────────────────────────────────────────────────────────
  // "oai-events" is the channel name required by the OpenAI Realtime protocol.
  const dc = pc.createDataChannel("oai-events");

  dc.addEventListener("message", (evt: MessageEvent<string>) => {
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(evt.data) as RealtimeEvent;
    } catch {
      console.warn("[realtime] Non-JSON data channel message:", evt.data);
      return;
    }
    onEvent(parsed);
  });

  // ── SDP offer / answer (WHIP protocol) ─────────────────────────────────────
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // POST the SDP offer to OpenAI. OpenAI acts as a WHIP endpoint.
  const sdpResponse = await fetch(
    `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    }
  );

  if (!sdpResponse.ok) {
    pc.close();
    throw new Error(
      `OpenAI WHIP SDP exchange failed: ${sdpResponse.status} ${await sdpResponse.text()}`
    );
  }

  const sdpAnswer = await sdpResponse.text();
  await pc.setRemoteDescription({ type: "answer", sdp: sdpAnswer });

  console.log("[realtime] WebRTC connection established");

  return {
    pc,
    dc,
    close: () => {
      pc.close();
      micStream.getTracks().forEach((t) => t.stop());
      audioEl.srcObject = null;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 4–8 — Handle Realtime events + call backend tools
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Sends a Realtime API event to OpenAI via the data channel.
 * Full event reference: https://platform.openai.com/docs/api-reference/realtime-client-events
 */
function sendEvent(dc: RTCDataChannel, event: RealtimeEvent): void {
  if (dc.readyState !== "open") {
    console.warn("[realtime] Data channel not open — dropping event:", event.type);
    return;
  }
  dc.send(JSON.stringify(event));
}

/**
 * Main event handler — processes all events from OpenAI via the data channel.
 *
 * Key events:
 *   session.created                            — connection confirmed
 *   input_audio_buffer.speech_started          — user started speaking (barge-in trigger)
 *   input_audio_buffer.speech_stopped          — user stopped speaking
 *   conversation.item.input_audio_transcription.completed — final user transcript
 *   response.function_call_arguments.done      — model wants to call a tool
 *   response.audio.delta                       — audio chunk being played (for UI)
 *   response.done                              — assistant turn complete
 *   error                                      — error from OpenAI
 */
function createEventHandler(
  dc: RTCDataChannel,
  onBookingUpdate: (result: BookingTurnResponse) => void,
  onStatusChange: (status: string) => void
) {
  // Track the booking session ID across turns.
  let bookingSessionId: string | undefined;

  // Track whether the assistant is currently playing audio (for barge-in).
  let isAssistantSpeaking = false;

  return async function handleRealtimeEvent(event: RealtimeEvent): Promise<void> {
    const { type } = event;
    console.log(`[realtime] ← ${type}`, event);

    switch (type) {
      // ── Session ready ────────────────────────────────────────────────────
      case "session.created":
        onStatusChange("connected");
        console.log("[realtime] Session ready. Start speaking.");
        break;

      // ── User started speaking (barge-in) ─────────────────────────────────
      case "input_audio_buffer.speech_started":
        if (isAssistantSpeaking) {
          console.log("[realtime] Barge-in detected — cancelling assistant response");
          // Cancel the current assistant response. OpenAI immediately stops
          // streaming audio to the browser. No manual audio stop needed because
          // the Web Audio output track goes silent as soon as streaming stops.
          sendEvent(dc, { type: "response.cancel" });
          isAssistantSpeaking = false;
          onStatusChange("listening");
        }
        break;

      // ── User finished speaking ────────────────────────────────────────────
      case "input_audio_buffer.speech_stopped":
        onStatusChange("processing");
        break;

      // ── Final transcript available ────────────────────────────────────────
      // This event fires when OpenAI's server-side transcription is complete.
      // We log it for UI purposes; the actual booking processing happens in
      // response.function_call_arguments.done (when the model calls the tool).
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript as string | undefined;
        if (transcript) {
          console.log(`[realtime] 📝 User said: "${transcript}"`);
          onStatusChange(`heard: "${transcript.slice(0, 50)}"`);
        }
        break;
      }

      // ── Model wants to call a tool ─────────────────────────────────────────
      case "response.function_call_arguments.done": {
        const callId   = event.call_id as string;
        const name     = event.name as string;
        const argsJson = event.arguments as string;

        if (name !== "process_booking_turn") {
          console.warn(`[realtime] Unknown tool call: ${name}`);
          break;
        }

        let args: { sessionId?: string; transcript: string };
        try {
          args = JSON.parse(argsJson) as typeof args;
        } catch {
          console.error("[realtime] Failed to parse tool arguments:", argsJson);
          break;
        }

        console.log(`[realtime] 🔧 Tool call: process_booking_turn`, args);
        onStatusChange("booking agent thinking…");

        // ── Call our backend ──────────────────────────────────────────────
        let bookingResult: BookingTurnResponse;
        try {
          const response = await fetch(`${BACKEND_URL}/tools/process-booking-turn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // Prefer the model-provided sessionId (from earlier in the
              // conversation); fall back to our locally tracked one.
              sessionId: args.sessionId ?? bookingSessionId,
              transcript: args.transcript,
            }),
          });

          if (!response.ok) {
            throw new Error(`${response.status} ${await response.text()}`);
          }

          bookingResult = (await response.json()) as BookingTurnResponse;
        } catch (err) {
          console.error("[realtime] Backend tool call failed:", err);
          // Return an error result to the model so it can apologise gracefully.
          sendEvent(dc, {
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ error: "Booking service temporarily unavailable" }),
            },
          });
          sendEvent(dc, { type: "response.create" });
          break;
        }

        // Persist sessionId for all subsequent turns in this conversation.
        bookingSessionId = bookingResult.sessionId;

        console.log("[realtime] ✅ Backend result:", {
          message: bookingResult.message,
          missingFields: bookingResult.missingFields,
          isReadyForConfirmation: bookingResult.isReadyForConfirmation,
          metrics: bookingResult.metrics,
        });

        // Notify the application layer (e.g. to update a React state).
        onBookingUpdate(bookingResult);

        // ── Send tool result back to OpenAI ───────────────────────────────
        // The model reads `output.message` and speaks it to the user.
        sendEvent(dc, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              message: bookingResult.message,
              missingFields: bookingResult.missingFields,
              isReadyForConfirmation: bookingResult.isReadyForConfirmation,
            }),
          },
        });

        // Ask the model to generate an audio response with the tool result.
        sendEvent(dc, { type: "response.create" });
        onStatusChange("assistant speaking");
        break;
      }

      // ── Assistant is streaming audio ──────────────────────────────────────
      case "response.audio.delta":
        isAssistantSpeaking = true;
        onStatusChange("assistant speaking");
        break;

      // ── Assistant turn finished ───────────────────────────────────────────
      case "response.done":
        isAssistantSpeaking = false;
        onStatusChange("listening");
        break;

      // ── Error from OpenAI ─────────────────────────────────────────────────
      case "error": {
        const errorCode    = (event.error as Record<string, unknown>)?.code;
        const errorMessage = (event.error as Record<string, unknown>)?.message;
        console.error(`[realtime] OpenAI error [${String(errorCode)}]:`, errorMessage);
        onStatusChange(`error: ${String(errorMessage)}`);
        break;
      }

      default:
        // Silently ignore informational events we don't need to act on.
        // (response.audio.done, rate_limits.updated, etc.)
        break;
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API — call these from your component
// ──────────────────────────────────────────────────────────────────────────────

/**
 * startRealtimeSession — the single entry point to start a voice session.
 *
 * Returns a `stop` function to cleanly end the session.
 *
 * @example
 * ```ts
 * // In a React "use client" component:
 * const stopSession = await startRealtimeSession({
 *   onBookingUpdate: (result) => {
 *     setDraft(result.bookingDraft);
 *     setMissing(result.missingFields);
 *   },
 *   onStatusChange: setStatus,
 * });
 *
 * // When user clicks "End call":
 * stopSession();
 * ```
 */
export async function startRealtimeSession(options: {
  onBookingUpdate: (result: BookingTurnResponse) => void;
  onStatusChange: (status: string) => void;
}): Promise<() => void> {
  const { onBookingUpdate, onStatusChange } = options;

  onStatusChange("connecting…");

  // Step 1: Get ephemeral token from our backend (OPENAI_API_KEY stays server-side).
  const sessionToken = await fetchEphemeralToken();

  // Step 2–3: Create WebRTC connection.
  // We create a temporary placeholder first so the dc reference can be closed
  // over inside createRealtimeConnection's onEvent callback.
  // The actual handler is wired up below once `dc` is available.
  const conn = await createRealtimeConnection(
    sessionToken.clientSecret,
    () => { /* events handled by dc.onmessage below */ }
  );

  const { pc, dc, close } = conn;

  // Wire up the real event handler now that we have the dc reference.
  const handleEvent = createEventHandler(dc, onBookingUpdate, onStatusChange);
  dc.addEventListener("message", (evt: MessageEvent<string>) => {
    let parsed: RealtimeEvent;
    try { parsed = JSON.parse(evt.data) as RealtimeEvent; }
    catch { return; }
    void handleEvent(parsed);
  });

  // Return a stop function for clean teardown.
  return function stop() {
    onStatusChange("disconnected");
    close();
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Self-contained usage example (run in browser console or a plain HTML page)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Minimal standalone example — no framework needed.
 *
 * Paste this into the browser DevTools console on a page served over HTTPS
 * (or localhost) to try the full flow interactively.
 */
export async function runInteractiveExample(): Promise<void> {
  console.log("=== SuccessVan Realtime Example ===");
  console.log("Fetching ephemeral token from backend…");

  // 1. Get token
  const tokenResp = await fetch(`${BACKEND_URL}/realtime/session`);
  if (!tokenResp.ok) throw new Error(`Token fetch failed: ${tokenResp.status}`);
  const { clientSecret, expiresAt, realtimeSessionId } =
    (await tokenResp.json()) as SessionTokenResponse;

  console.log(`Token expires at: ${new Date(expiresAt).toISOString()}`);
  console.log(`Realtime session ID: ${realtimeSessionId}`);

  // 2. Mic
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  console.log("Microphone acquired.");

  // 3. PeerConnection
  const pc = new RTCPeerConnection();
  mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));

  const audio = document.createElement("audio");
  audio.autoplay = true;
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };

  // 4. Data channel
  let bookingSessionId: string | undefined;
  const dc = pc.createDataChannel("oai-events");

  dc.onopen = () => console.log("Data channel open. Start speaking!");

  dc.onmessage = async (evt: MessageEvent<string>) => {
    const event = JSON.parse(evt.data) as RealtimeEvent;

    if (event.type === "response.function_call_arguments.done") {
      const callId   = event.call_id as string;
      const argsJson = event.arguments as string;
      const args     = JSON.parse(argsJson) as { sessionId?: string; transcript: string };

      console.log("Tool call — transcript:", args.transcript);

      // 5. Call backend
      const r = await fetch(`${BACKEND_URL}/tools/process-booking-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: args.sessionId ?? bookingSessionId, transcript: args.transcript }),
      });
      const result = (await r.json()) as BookingTurnResponse;
      bookingSessionId = result.sessionId;

      console.log("Agent says:", result.message);
      console.log("Draft:", result.bookingDraft);
      console.log("Missing:", result.missingFields);

      // 6. Return tool result to model
      dc.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ message: result.message, missingFields: result.missingFields }),
        },
      }));
      dc.send(JSON.stringify({ type: "response.create" }));
    }
  };

  // 5. SDP offer → OpenAI WHIP
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch(
    `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    }
  );
  if (!sdpResp.ok) throw new Error(`SDP exchange failed: ${sdpResp.status}`);

  await pc.setRemoteDescription({ type: "answer", sdp: await sdpResp.text() });
  console.log("WebRTC connected. Speak now!");

  // To stop: pc.close(); mic.getTracks().forEach(t => t.stop());
  (window as unknown as Record<string, unknown>)._stopRealtime = () => {
    pc.close();
    mic.getTracks().forEach((t) => t.stop());
    console.log("Session stopped.");
  };
  console.log("Run _stopRealtime() to end the session.");
}
