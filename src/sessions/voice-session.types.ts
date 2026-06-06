import type { BookingDraft } from "../agent/types/booking.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Session status
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The status of a session at any point in time.
 *
 * idle        → waiting for the next start_turn
 * recording   → user is speaking, audio chunks are arriving
 * transcribing → audio is being sent to STT
 * processing  → agent pipeline is running
 * error       → last turn failed
 */
export type SessionStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "processing"
  | "error";

// ──────────────────────────────────────────────────────────────────────────────
// Turn metrics
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Wall-clock timing for each phase of a turn.
 * All values are milliseconds, rounded to integer.
 * Used by the frontend to show latency and by the backend logs.
 */
export type TurnMetrics = {
  audioSaveMs?: number;
  transcriptionMs?: number;
  contextLoadMs?: number;
  resolverMs?: number;
  aiExtractionMs?: number;
  ttsMs?: number;
  agentTotalMs?: number;
  totalTurnMs?: number;
};

// ──────────────────────────────────────────────────────────────────────────────
// Turn history record
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A completed turn stored in session history.
 * Useful for debugging, analytics, and future context injection.
 */
export type TurnRecord = {
  turnId: string;
  userTranscript: string;
  agentMessage: string;
  metrics: TurnMetrics;
  timestamp: number; // Unix ms
};

// ──────────────────────────────────────────────────────────────────────────────
// Voice session
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The persistent state of one booking conversation.
 *
 * This is what gets stored in the session store (ISessionStore).
 * It survives WebSocket reconnections as long as the TTL has not expired.
 *
 * Audio chunks for the current turn are NOT stored here — they are held
 * in a transient Map inside VoiceSessionManager and discarded after each turn.
 * This keeps the session object small and serialisable (important for Redis).
 */
export type VoiceSession = {
  sessionId: string;

  /** Current pipeline status. */
  status: SessionStatus;

  /**
   * The booking fields collected so far across all turns.
   * This is the single source of truth for what the user has said.
   */
  bookingDraft: BookingDraft;

  /**
   * Ordered history of completed turns.
   * Used for debugging. Could be used later to inject conversation context into GPT.
   */
  turns: TurnRecord[];

  /** ID of the turn currently in progress, or null when idle. */
  currentTurnId: string | null;

  /** Updated on every message. Used for TTL expiry. */
  lastActivityAt: number;

  /** Set once at session creation. */
  createdAt: number;
};
