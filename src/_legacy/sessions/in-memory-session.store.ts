import type { ISessionStore } from "./session-store.interface.js";
import type { VoiceSession } from "./voice-session.types.js";

/**
 * In-memory session store backed by a plain Map.
 *
 * Suitable for:
 *   - Development and testing
 *   - Single-instance deployments with short call durations
 *
 * Limitations:
 *   - Sessions are lost on process restart
 *   - Does not work across multiple server instances (no shared state)
 *
 * To switch to Redis:
 *   1. `npm install ioredis`
 *   2. Create `src/sessions/redis-session.store.ts` implementing ISessionStore
 *   3. Replace `new InMemorySessionStore()` with `new RedisSessionStore(redisClient)`
 *      in voice-session.manager.ts — no other code changes needed
 */
export class InMemorySessionStore implements ISessionStore {
  private readonly sessions = new Map<string, VoiceSession>();

  async get(sessionId: string): Promise<VoiceSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async set(session: VoiceSession): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async prune(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }
}
