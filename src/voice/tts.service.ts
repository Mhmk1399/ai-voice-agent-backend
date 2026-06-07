import { openai } from "../ai/openai.client.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TtsResult = {
  /** Base64-encoded audio data. */
  audioBase64: string;
  mimeType: string;
};

// ──────────────────────────────────────────────────────────────────────────────
// Batch TTS  (legacy fallback)
// ──────────────────────────────────────────────────────────────────────────────

/** Generate a full MP3 in one shot. Kept for non-streaming callers. */
export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "alloy",
    input: text,
    response_format: "mp3",
  });

  const arrayBuffer = await response.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
  return { audioBase64, mimeType: "audio/mpeg" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Streaming TTS  (primary path)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Stream raw PCM audio from OpenAI TTS and deliver it in chunks.
 *
 * PCM format: 16-bit signed integer, little-endian, mono, 24 000 Hz.
 * This is the same format used by Web Audio API AudioBuffer, so the browser
 * can decode and schedule each chunk immediately without waiting for the
 * whole response.
 *
 * Latency improvement:
 *   Batch (old):    4 000–5 000 ms before first audio byte leaves the server.
 *   Streaming:      ~200–400 ms to first chunk → user hears first word immediately.
 *
 * Barge-in cancellation:
 *   Set `signal.aborted = true` to stop after the current chunk.
 *   The underlying HTTP stream is cancelled, stopping data transfer.
 *
 * @param text     - Text to speak.
 * @param onChunk  - Called for every PCM chunk received. Do NOT await inside.
 * @param signal   - Shared cancellation token. Set .aborted = true to stop.
 * @returns { completed: true } if all chunks were sent, { completed: false } if aborted.
 */
export async function streamSpeech(params: {
  text: string;
  onChunk: (data: Buffer, index: number) => void;
  signal: { aborted: boolean };
}): Promise<{ completed: boolean }> {
  const { text, onChunk, signal } = params;

  const response = await openai.audio.speech.create({
    model: "tts-1",
    voice: "alloy",
    input: text,
    response_format: "pcm", // raw PCM 16-bit LE, 24 000 Hz, mono
  });

  // response.body is a Web API ReadableStream<Uint8Array> (Node 18+)
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) throw new Error("OpenAI TTS returned no response body");

  const reader = body.getReader();
  let index = 0;
  let completed = false;

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      onChunk(Buffer.from(value), index++);
    }
  } finally {
    // If we exited early (barge-in), cancel the HTTP stream to free bandwidth.
    if (!completed) {
      reader.cancel().catch(() => {});
    }
  }

  return { completed };
}

