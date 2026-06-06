import { openai } from "../ai/openai.client.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TtsResult = {
  /** Base64-encoded audio data. Ready to embed in a WebSocket JSON message. */
  audioBase64: string;

  /** MIME type of the encoded audio (e.g. "audio/mpeg"). */
  mimeType: string;
};

// ──────────────────────────────────────────────────────────────────────────────
// TTS function
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Generate speech from text using the OpenAI TTS API.
 *
 * Returns base64-encoded MP3 audio that can be:
 *   - Sent directly in a WebSocket `tts_audio` message (current approach).
 *   - Written to a temp file and served as a URL (alternative approach).
 *
 * The frontend decodes the base64 string and plays it via the Web Audio API
 * or an <audio> element.
 *
 * Voice options: alloy, echo, fable, onyx, nova, shimmer.
 * "alloy" is neutral and works well for a professional booking agent.
 *
 * To switch to a different TTS provider later, replace the body of this
 * function — the return type stays the same so callers don't change.
 */
export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  // openai.audio.speech.create() returns a standard Web API Response object.
  // We read the full body into an ArrayBuffer, then convert to base64.
  const response = await openai.audio.speech.create({
    model: "tts-1",   // tts-1-hd for higher quality (slower)
    voice: "alloy",
    input: text,
    response_format: "mp3",
  });

  // The SDK returns a Response; arrayBuffer() reads the full body.
  const arrayBuffer = await response.arrayBuffer();
  const audioBase64 = Buffer.from(arrayBuffer).toString("base64");

  return {
    audioBase64,
    mimeType: "audio/mpeg",
  };
}
