"use client";

import { useRef, useState, useEffect } from "react";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

type BookingDraft = Record<string, unknown>;

type SessionStatus =
  | "disconnected"
  | "connecting"
  | "idle"        // session open, mic may be on, waiting for user
  | "recording"   // user is speaking, chunks are flowing
  | "processing"  // end_turn sent, waiting for pipeline
  | "error";

type LogEntry = {
  id: number;
  time: string;
  direction: "in" | "out" | "system";
  type: string;
  summary: string;
  raw: unknown;
};

// ──────────────────────────────────────────────────────────────────────────────
// PcmPlayer
//
// Plays PCM chunks from the TTS stream in order with no gaps.
// Format: 16-bit signed int, little-endian, mono, 24 000 Hz.
//
// Each chunk is decoded to Float32 and scheduled on the Web Audio API
// immediately. Chunks play back-to-back with a tiny 10ms guard margin.
// ──────────────────────────────────────────────────────────────────────────────

class PcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  readonly sampleRate = 24000;

  /** True while scheduled audio is still ahead of current playback position. */
  get isPlaying(): boolean {
    if (!this.ctx) return false;
    return this.nextStartTime > this.ctx.currentTime + 0.05;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.nextStartTime = 0;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Decode a base64 PCM chunk and schedule it to play after the previous one. */
  playChunk(base64: string): void {
    const ctx = this.ensureCtx();

    // base64 → raw bytes
    const bStr = atob(base64);
    const bytes = new Uint8Array(bStr.length);
    for (let i = 0; i < bStr.length; i++) bytes[i] = bStr.charCodeAt(i);

    // Int16 PCM → normalised Float32 [-1 .. 1]
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = ctx.createBuffer(1, float32.length, this.sampleRate);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Schedule after previous chunk. 10 ms guard prevents tiny gaps.
    const startAt = Math.max(ctx.currentTime + 0.01, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  /** Immediately stop all scheduled audio (barge-in or session end). */
  stop(): void {
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close();
      this.ctx = null;
    }
    this.nextStartTime = 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const WS_URL = "ws://localhost:4010/voice/web";
/** RMS amplitude threshold: above = speaking, below = silence. */
const VOICE_THRESHOLD = 0.018;
/** How long continuous silence triggers auto end_turn. */
const SILENCE_MS = 1200;
/**
 * Minimum recording duration before VAD can fire auto end_turn.
 * Prevents empty turns immediately after auto-start (when the room is quiet).
 * The user must speak at least once OR 1.5s must pass before silence is respected.
 */
const MIN_TURN_MS = 1500;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", {
    hour12: false,
    fractionalSecondDigits: 2,
  });
}

const TYPE_STYLES: Record<string, string> = {
  session_created:       "text-emerald-700 bg-emerald-50 border-emerald-200",
  turn_started:          "text-blue-700 bg-blue-50 border-blue-200",
  audio_chunk_received:  "text-gray-400 bg-gray-50 border-gray-100",
  transcription_started: "text-amber-700 bg-amber-50 border-amber-200",
  transcript_final:      "text-amber-900 bg-amber-100 border-amber-300",
  agent_started:         "text-violet-700 bg-violet-50 border-violet-200",
  agent_response:        "text-violet-900 bg-violet-100 border-violet-300",
  tts_chunk:             "text-pink-400 bg-pink-50 border-pink-100",
  tts_done:              "text-pink-700 bg-pink-50 border-pink-200",
  barge_in_ack:          "text-orange-700 bg-orange-50 border-orange-200",
  latency:               "text-teal-700 bg-teal-50 border-teal-200",
  error:                 "text-red-700 bg-red-100 border-red-300",
  start_turn:            "text-blue-600 bg-blue-50 border-blue-200",
  end_turn:              "text-orange-600 bg-orange-50 border-orange-200",
  end_session:           "text-red-600 bg-red-50 border-red-200",
  audio_chunk:           "text-gray-400 bg-gray-50 border-gray-100",
  barge_in:              "text-orange-700 bg-orange-50 border-orange-200",
  system:                "text-gray-500 bg-white border-gray-200",
};
function styleFor(t: string) {
  return TYPE_STYLES[t] ?? "text-gray-700 bg-gray-50 border-gray-200";
}

// ──────────────────────────────────────────────────────────────────────────────
// LogRow
// ──────────────────────────────────────────────────────────────────────────────

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const dir = entry.direction === "in" ? "←" : entry.direction === "out" ? "→" : "·";

  return (
    <div
      className={`rounded border px-2 py-1 cursor-pointer select-none ${styleFor(entry.type)}`}
      onClick={() => entry.raw && setOpen(v => !v)}
    >
      <div className="flex items-baseline gap-2 overflow-hidden">
        <span className="shrink-0 text-[10px] opacity-50 tabular-nums">{entry.time}</span>
        <span className="shrink-0 font-bold w-3">{dir}</span>
        <span className="shrink-0 font-semibold">{entry.type}</span>
        <span className="truncate opacity-80 text-xs">{entry.summary}</span>
        {entry.raw && (
          <span className="ml-auto shrink-0 text-[10px] opacity-40">{open ? "▲" : "▼"}</span>
        )}
      </div>
      {open && entry.raw && (
        <pre className="mt-1 overflow-x-auto text-[11px] opacity-80 leading-relaxed whitespace-pre-wrap">
          {JSON.stringify(entry.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Main component
// ──────────────────────────────────────────────────────────────────────────────

export default function VoiceTestPage() {
  // ── Refs (stable, not for rendering) ──────────────────────────────────────
  const wsRef           = useRef<WebSocket | null>(null);
  const recorderRef     = useRef<MediaRecorder | null>(null);
  /**
   * The microphone stream is kept alive for the entire session.
   * The MediaRecorder starts/stops per turn, but the mic itself stays open
   * so VAD can always monitor input (including during TTS playback for barge-in).
   */
  const micStreamRef    = useRef<MediaStream | null>(null);
  const pcmPlayerRef    = useRef(new PcmPlayer());
  const sequenceRef     = useRef(0);
  const logIdRef        = useRef(0);
  /**
   * Timestamp (Date.now()) when the current recording turn started.
   * VAD will not trigger auto end_turn until at least MIN_TURN_MS ms have
   * elapsed — prevents empty turns when silence is detected right after
   * auto-start (e.g. the very beginning of a turn before the user speaks).
   */
  const turnStartTimeRef = useRef(0);

  // VAD internals
  const micCtxRef       = useRef<AudioContext | null>(null);
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const vadRafRef       = useRef<number | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef   = useRef(false);

  // Mirrors of state used inside rAF callbacks (avoid stale closures)
  const statusRef      = useRef<SessionStatus>("disconnected");
  const isTtsActiveRef = useRef(false);

  // ── React state (controls rendering) ──────────────────────────────────────
  const [status,       setStatus]      = useState<SessionStatus>("disconnected");
  const [sessionId,    setSessionId]   = useState<string | null>(null);
  const [turnId,       setTurnId]      = useState<string | null>(null);
  const [agentMessage, setAgentMsg]    = useState("");
  const [draft,        setDraft]       = useState<BookingDraft>({});
  const [missing,      setMissing]     = useState<string[]>([]);
  const [isReady,      setIsReady]     = useState(false);
  const [metrics,      setMetrics]     = useState<Record<string, number> | null>(null);
  const [logs,         setLogs]        = useState<LogEntry[]>([]);
  const [audioLevel,   setAudioLevel]  = useState(0);    // 0–1 mic RMS
  const [isTtsActive,  setIsTtsActive] = useState(false);
  const [silenceSecs,  setSilenceSecs] = useState<number | null>(null); // countdown

  // Keep ref mirrors in sync
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { isTtsActiveRef.current = isTtsActive; }, [isTtsActive]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopVad();
      pcmPlayerRef.current.stop();
      micStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Logging ────────────────────────────────────────────────────────────────
  function addLog(dir: LogEntry["direction"], type: string, summary: string, raw?: unknown) {
    logIdRef.current += 1;
    setLogs(prev => [
      { id: logIdRef.current, time: timestamp(), direction: dir, type, summary, raw: raw ?? null },
      ...prev,
    ]);
  }

  // ── VAD ────────────────────────────────────────────────────────────────────
  //
  // The VAD runs continuously while the mic stream is open (whole session).
  // It triggers two behaviours:
  //   1. During recording: silence > SILENCE_MS → auto end_turn
  //   2. During TTS playback: voice detected → barge-in (stop audio + new turn)

  function startVad(stream: MediaStream) {
    const ctx = new AudioContext();
    micCtxRef.current = ctx;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;

    ctx.createMediaStreamSource(stream).connect(analyser);

    const buf = new Float32Array(analyser.frequencyBinCount);

    function monitor() {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

      // Smooth the level display (exponential moving average)
      setAudioLevel(prev => prev * 0.6 + rms * 0.4);

      const isVoice = rms > VOICE_THRESHOLD;

      if (isVoice) {
        // ── Voice detected ─────────────────────────────────────────────
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
          setSilenceSecs(null);
        }

        if (!isSpeakingRef.current) {
          isSpeakingRef.current = true;

          // Barge-in: user speaks while TTS is playing
          if (isTtsActiveRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            addLog("system", "system", "Barge-in detected — interrupting TTS");
            pcmPlayerRef.current.stop();
            setIsTtsActive(false);
            wsRef.current.send(JSON.stringify({ type: "barge_in" }));
            addLog("out", "barge_in", "→ barge_in");
          }
        }
      } else {
        // ── Silence ────────────────────────────────────────────────────
        isSpeakingRef.current = false;

        // Only arm the auto-stop timer once the turn is old enough (MIN_TURN_MS).
        // This prevents an empty turn from firing immediately after auto-start
        // when the room is quiet before the user starts speaking.
        const recordedMs = Date.now() - turnStartTimeRef.current;

        if (statusRef.current === "recording" && !silenceTimerRef.current && recordedMs > MIN_TURN_MS) {
          const deadline = Date.now() + SILENCE_MS;

          // Animated countdown
          const tick = setInterval(() => {
            const left = deadline - Date.now();
            setSilenceSecs(left > 0 ? Math.ceil(left / 100) / 10 : 0);
            if (left <= 0) clearInterval(tick);
          }, 80);

          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            setSilenceSecs(null);
            clearInterval(tick);
            if (statusRef.current === "recording") {
              addLog("system", "system", "VAD: silence → auto end_turn");
              endTurn();
            }
          }, SILENCE_MS);
        }
      }

      vadRafRef.current = requestAnimationFrame(monitor);
    }

    vadRafRef.current = requestAnimationFrame(monitor);
  }

  function stopVad() {
    if (vadRafRef.current !== null) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (micCtxRef.current?.state !== "closed") {
      void micCtxRef.current?.close();
    }
    micCtxRef.current = null;
    analyserRef.current = null;
    isSpeakingRef.current = false;
    setSilenceSecs(null);
    setAudioLevel(0);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  function connectWs(): WebSocket {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;

    setStatus("connecting");
    addLog("system", "system", `Connecting → ${WS_URL}`);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => addLog("system", "system", "WebSocket open");

    ws.onerror = () => {
      addLog("system", "error", "WebSocket error");
      setStatus("error");
    };

    ws.onclose = e => {
      addLog("system", "system", `WebSocket closed (code ${e.code})`);
      wsRef.current = null;
      setStatus("disconnected");
      setSessionId(null);
      setTurnId(null);
      stopVad();
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      pcmPlayerRef.current.stop();
    };

    ws.onmessage = evt => {
      let data: Record<string, unknown>;
      try { data = JSON.parse(evt.data as string) as Record<string, unknown>; }
      catch { addLog("in", "raw", String(evt.data)); return; }
      handleMessage(data);
    };

    return ws;
  }

  // ── Server message handler ─────────────────────────────────────────────────

  function handleMessage(data: Record<string, unknown>) {
    const type = data.type as string;

    switch (type) {
      case "session_created": {
        const sid = data.sessionId as string;
        setSessionId(sid);
        setStatus("idle");
        addLog("in", type, `Session → ${sid.slice(0, 8)}…`, data);
        // Immediately start the first recording turn — the conversation is fully
        // automatic from this point. User never needs to press a button again.
        void startTurnOnSocket();
        break;
      }

      case "turn_started": {
        setTurnId(data.turnId as string);
        setStatus("recording");
        addLog("in", type, `Turn → ${(data.turnId as string).slice(0, 8)}…`, data);
        break;
      }

      case "audio_chunk_received": {
        const seq = data.sequence as number;
        if (seq % 5 === 0) addLog("in", type, `ACK #${seq} (${data.bytes}b)`, data);
        break;
      }

      case "transcription_started":
        setStatus("processing");
        addLog("in", type, "Transcribing…", data);
        break;

      case "transcript_final":
        addLog("in", type, `📝 "${data.transcript}"`, data);
        break;

      case "agent_started":
        addLog("in", type, "Agent thinking…", data);
        break;

      case "agent_response": {
        const msg   = data.message as string;
        const d     = data.bookingDraft as BookingDraft;
        const miss  = data.missingFields as string[];
        const ready = data.isReadyForConfirmation as boolean;
        setAgentMsg(msg);
        setDraft(d);
        setMissing(miss);
        setIsReady(ready);
        setStatus("idle");
        setIsTtsActive(true); // TTS chunks will start arriving immediately
        addLog(
          "in", type,
          `🤖 "${msg}"  |  missing: [${miss.join(", ") || "none"}]${ready ? " ✅" : ""}`,
          data
        );
        break;
      }

      case "tts_chunk": {
        const idx = data.index as number;
        if (idx === 0) {
          addLog("in", type, "🔊 First PCM chunk — audio starting", {
            ...data,
            dataBase64: "[omitted]",
          });
        }
        pcmPlayerRef.current.playChunk(data.dataBase64 as string);
        break;
      }

      case "tts_done": {
        addLog("in", type, "TTS stream complete", data);
        // Poll until all buffered PCM chunks have played out, then loop back.
        // 400ms extra pause after playback ends gives a natural conversation gap
        // and prevents the mic from picking up the last echo of the speaker.
        const waitThenLoop = () => {
          if (pcmPlayerRef.current.isPlaying) {
            setTimeout(waitThenLoop, 120);
          } else {
            setIsTtsActive(false);
            setTimeout(() => {
              // Auto-start the next recording turn (continuous conversation loop)
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                addLog("system", "system", "Auto-starting next turn…");
                void startTurnOnSocket();
              }
            }, 400);
          }
        };
        setTimeout(waitThenLoop, 120);
        break;
      }

      case "barge_in_ack": {
        addLog("in", type, "Barge-in ACK — starting new turn", data);
        // Auto-start new recording turn without requiring a button press
        void startTurnOnSocket();
        break;
      }

      case "latency": {
        const m = data.metrics as Record<string, number>;
        setMetrics(m);
        addLog(
          "in", type,
          `⏱ ${Object.entries(m).map(([k, v]) => `${k}=${v}ms`).join("  ")}`,
          data
        );
        break;
      }

      case "error":
        setStatus("idle");
        addLog("in", type, `❌ ${data.message as string}`, data);
        break;

      default:
        addLog("in", type, JSON.stringify(data));
    }
  }

  // ── Turn control ───────────────────────────────────────────────────────────

  /**
   * "Connect" — request mic + open WebSocket + begin the conversation.
   * session_created → auto start_turn → VAD loop handles everything from here.
   */
  async function connect() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Already connected, just start a new turn manually
      await startTurnOnSocket();
      return;
    }
    // Request mic first (needs user gesture), then open WebSocket.
    // session_created handler will call startTurnOnSocket automatically.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation prevents the agent's TTS voice from being
          // picked up by the mic and triggering false VAD detections.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      startVad(stream);
    } catch (e) {
      addLog("system", "error", `Mic denied: ${String(e)}`);
      return;
    }
    connectWs();
  }

  async function startTurnOnSocket() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Guard: don't double-start if already recording
    if (statusRef.current === "recording") return;

    // Mic stream should already be open (opened in connect()).
    // Fallback: open it here if somehow it was closed.
    if (!micStreamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        micStreamRef.current = stream;
        startVad(stream);
      } catch (e) {
        addLog("system", "error", `Mic denied: ${String(e)}`);
        return;
      }
    }

    turnStartTimeRef.current = Date.now(); // record when this turn began
    sequenceRef.current = 0;
    ws.send(JSON.stringify({ type: "start_turn" }));
    addLog("out", "start_turn", "→ start_turn");

    // New MediaRecorder on the existing mic stream (previous one was stopped)
    const recorder = new MediaRecorder(micStreamRef.current, { mimeType: "audio/webm" });
    recorderRef.current = recorder;

    recorder.ondataavailable = async evt => {
      if (!evt.data.size) return;
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const buf = await evt.data.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);

      sequenceRef.current += 1;
      wsRef.current.send(JSON.stringify({
        type: "audio_chunk",
        audioBase64: btoa(binary),
        mimeType: evt.data.type || "audio/webm",
        sequence: sequenceRef.current,
      }));
      addLog("out", "audio_chunk", `→ chunk #${sequenceRef.current} (${buf.byteLength}b)`);
    };

    recorder.start(500); // emit a chunk every 500 ms
  }

  function endTurn() {
    const r = recorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    // Do NOT stop the mic stream — VAD must keep running for barge-in detection
    recorderRef.current = null;

    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end_turn" }));
      addLog("out", "end_turn", "→ end_turn");
    }
    setStatus("processing");
  }

  function endSession() {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "end_session" }));
      addLog("out", "end_session", "→ end_session");
    }
    stopVad();
    pcmPlayerRef.current.stop();
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
  }

  // ── Derived state ──────────────────────────────────────────────────────────
  const isConnected  = !["disconnected", "error"].includes(status);
  const isRecording  = status === "recording";
  const isProcessing = status === "processing" || status === "connecting";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gray-50 p-6 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold text-gray-900">
        Voice Agent — Debug Console
      </h1>

      {/* ── Status bar ────────────────────────────────────────────────────── */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-gray-200 bg-white px-4 py-3">
        <span>
          Status:{" "}
          <span className={`font-semibold ${
            isRecording  ? "text-red-600" :
            isProcessing ? "text-amber-600" :
            isTtsActive  ? "text-pink-600" :
            status === "idle" ? "text-green-600" : "text-gray-500"
          }`}>
            {status}
            {isRecording  && " 🎙"}
            {isProcessing && " ⏳"}
            {isTtsActive  && " 🔊"}
          </span>
        </span>

        {sessionId && (
          <span className="text-gray-500">
            Session: <code className="text-gray-800">{sessionId.slice(0, 8)}…</code>
          </span>
        )}
        {turnId && (
          <span className="text-gray-500">
            Turn: <code className="text-gray-800">{turnId.slice(0, 8)}…</code>
          </span>
        )}

        {/* Mic level bar + silence countdown */}
        {isConnected && micStreamRef.current && (
          <div className="flex items-center gap-2 ml-2">
            <span className="text-gray-400 text-xs">mic</span>
            <div className="h-2 w-28 rounded bg-gray-200 overflow-hidden">
              <div
                className={`h-full transition-all duration-75 ${
                  isRecording ? "bg-red-400" : "bg-gray-300"
                }`}
                style={{ width: `${Math.min(100, audioLevel * 600)}%` }}
              />
            </div>
            {silenceSecs !== null && (
              <span className="text-amber-500 text-xs font-semibold">
                stop in {silenceSecs.toFixed(1)}s
              </span>
            )}
            {isTtsActive && (
              <span className="text-orange-400 text-xs font-semibold animate-pulse">
                speak to barge-in
              </span>
            )}
          </div>
        )}

        {isReady && (
          <span className="ml-auto font-semibold text-green-700 bg-green-100 rounded px-2 py-0.5">
            ✅ Ready for confirmation
          </span>
        )}
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap gap-3">
        {/* Connect opens the mic + WS. After that the conversation is fully automatic.
            The session_created handler triggers start_turn, VAD handles silence,
            and tts_done restarts recording — no more button presses needed. */}
        <button
          onClick={() => void connect()}
          disabled={isConnected}
          className="rounded bg-green-600 px-5 py-2 text-white font-semibold hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isConnected ? "🟢 Connected" : "🎙 Connect"}
        </button>

        <button
          onClick={endTurn}
          disabled={!isRecording}
          className="rounded border border-orange-400 px-5 py-2 text-orange-700 font-semibold hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Force-stop current recording turn (VAD normally handles this automatically)"
        >
          ⏹ Force Stop
        </button>

        <button
          onClick={endSession}
          disabled={!isConnected}
          className="rounded border border-gray-400 px-5 py-2 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
        >
          End Session
        </button>

        <button
          onClick={() => { setLogs([]); setMetrics(null); }}
          className="ml-auto rounded border border-gray-300 px-4 py-2 text-gray-500 hover:bg-gray-100"
        >
          Clear
        </button>
      </div>

      {/* ── Two-column layout ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

        {/* Left panel: live state */}
        <div className="space-y-4 lg:col-span-1">

          {/* Agent message */}
          {agentMessage && (
            <div className="rounded border border-violet-200 bg-violet-50 p-4">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-violet-400">
                Agent says
              </div>
              <p className="text-violet-900 leading-relaxed">"{agentMessage}"</p>
              {isTtsActive && (
                <p className="mt-1 text-[10px] text-pink-500 animate-pulse">
                  🔊 streaming audio…
                </p>
              )}
            </div>
          )}

          {/* Booking draft */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Booking Draft
            </div>
            {Object.keys(draft).length === 0 ? (
              <p className="text-gray-400">empty — start talking</p>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(draft).map(([k, v]) => (
                    <tr key={k} className="border-b border-gray-100 last:border-0">
                      <td className="py-1 pr-3 font-semibold text-gray-600 whitespace-nowrap">{k}</td>
                      <td className="py-1 text-gray-900 break-all">
                        {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Missing fields */}
          {missing.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-4">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-amber-500">
                Still needed
              </div>
              {missing.map(f => (
                <div key={f} className="text-amber-800">• {f}</div>
              ))}
            </div>
          )}

          {/* Latency table */}
          {metrics && (
            <div className="rounded border border-teal-200 bg-teal-50 p-4">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-teal-500">
                Last Turn Latency
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {Object.entries(metrics).map(([k, v]) => (
                    <tr key={k} className="border-b border-teal-100 last:border-0">
                      <td className="py-1 pr-3 text-teal-700 whitespace-nowrap">{k}</td>
                      <td className={`py-1 font-semibold tabular-nums ${
                        v > 3000 ? "text-red-600" : v > 1500 ? "text-amber-600" : "text-teal-900"
                      }`}>{v} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Behaviour summary */}
          <div className="rounded border border-gray-100 bg-white p-3 text-[10px] text-gray-400 space-y-0.5">
            <p>
              <span className="font-semibold text-gray-500">Auto loop:</span>{" "}
              Connect → speak → silence → agent answers → TTS → next turn — fully hands-free
            </p>
            <p>
              <span className="font-semibold text-gray-500">VAD auto-stop:</span>{" "}
              {SILENCE_MS}ms silence after speaking → end_turn
            </p>
            <p>
              <span className="font-semibold text-gray-500">Barge-in:</span>{" "}
              speak while 🔊 playing → interrupts immediately
            </p>
            <p>
              <span className="font-semibold text-gray-500">TTS:</span>{" "}
              PCM 24kHz streaming — first word ≈ 300ms after agent response
            </p>
          </div>
        </div>

        {/* Right panel: event log */}
        <div className="lg:col-span-2">
          <div className="rounded border border-gray-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                Event Log — {logs.length} events
              </span>
              <span className="text-[10px] text-gray-400">click row for raw payload</span>
            </div>
            <div className="h-[640px] overflow-y-auto p-2 space-y-0.5">
              {logs.length === 0 ? (
                <p className="p-4 text-gray-400">
                  No events. Click <strong>🎙 Start Turn</strong> to begin.
                </p>
              ) : (
                logs.map(e => <LogRow key={e.id} entry={e} />)
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
