import type { VoiceSession } from "./voice-session.types.js";

/**
 * Abstraction over session storage.
 *
 * Default implementation: InMemorySessionStore (a plain Map).
 * Production replacement: RedisSessionStore — implement this interface and
 * inject it into VoiceSessionManager to get horizontal scaling + persistence.
 *
 * The interface is intentionally async even for the in-memory version so that
 * swapping to Redis requires zero changes in the manager or the route handlers.
 */
export interface ISessionStore {
  /** Load a session by ID. Returns null if not found. */
  get(sessionId: string): Promise<VoiceSession | null>;

  /** Persist a session (create or overwrite). */
  set(session: VoiceSession): Promise<void>;

  /** Delete a session permanently. */
  delete(sessionId: string): Promise<void>;

  /**
   * Remove all sessions whose lastActivityAt is older than maxAgeMs.
   * Called periodically by VoiceSessionManager to prevent memory leaks.
   */
  prune(maxAgeMs: number): Promise<void>;
}
