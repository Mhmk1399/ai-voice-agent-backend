import fs from "node:fs";
import { openai } from "../ai/openai.client.js";

// ──────────────────────────────────────────────────────────────────────────────
// Interface — Stage 6 abstraction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Abstraction for Speech-to-Text.
 *
 * Current implementation: OpenAI Whisper, file-based (batch).
 *
 * To move to realtime / streaming STT later:
 *   1. Add `startStream(sessionId: string): Promise<SttStream>` to this interface.
 *   2. Implement with OpenAI Realtime API or Deepgram streaming.
 *   3. The orchestrator subscribes to partial/final transcript events from the stream.
 *   4. The WebSocket handler calls `startStream` on `start_turn` and feeds chunks
 *      to the stream instead of buffering them.
 *
 * The file-based `transcribeFile` stays as the batch fallback.
 */
export interface SpeechToTextService {
  /**
   * Transcribe a saved audio file and return the transcript text.
   * This is the current batch implementation.
   */
  transcribeFile(filePath: string): Promise<string>;

  // ── Future streaming methods (not yet implemented) ─────────────────────────
  // startStream(sessionId: string): Promise<SttStream>;
  // SttStream would emit: 'partial' (text so far) and 'final' (committed text)
}

// ──────────────────────────────────────────────────────────────────────────────
// OpenAI implementation
// ──────────────────────────────────────────────────────────────────────────────

/** Batch transcription via OpenAI Whisper. */
export class OpenAiSttService implements SpeechToTextService {
  async transcribeFile(filePath: string): Promise<string> {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-mini-transcribe",
    });

    return transcription.text;
  }
}

/**
 * Shared singleton STT service.
 *
 * To swap in a different STT backend:
 *   1. Implement SpeechToTextService (e.g. DeepgramSttService).
 *   2. Replace `new OpenAiSttService()` here.
 *   3. No other files need changing.
 */
export const sttService: SpeechToTextService = new OpenAiSttService();
