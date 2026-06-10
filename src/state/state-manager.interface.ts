import type { BookingDraft } from "./booking-draft.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// State Manager Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface StateManager {
  /** Load session state. Creates a new draft if session doesn't exist. */
  load(sessionId: string): Promise<BookingDraft>;

  /** Persist updated draft. */
  save(sessionId: string, draft: BookingDraft): Promise<void>;

  /** Delete session (completed or expired). */
  delete(sessionId: string): Promise<void>;

  /** List all active session IDs (for debug endpoint). */
  listSessions(): Promise<string[]>;

  /** Get session count stats. */
  stats(): Promise<StateManagerStats>;
}

export interface StateManagerStats {
  activeSessions: number;
  totalCreated: number;
  totalDeleted: number;
}
