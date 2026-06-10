import { nanoid } from "nanoid";
import type { BookingDraft } from "./booking-draft.types.js";
import type { StateManager, StateManagerStats } from "./state-manager.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory State Manager
// Replace with a Redis or MongoDB backed implementation later by swapping this
// module behind the StateManager interface.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface StoredSession {
  draft: BookingDraft;
  expiresAt: number;
}

export class InMemoryStateManager implements StateManager {
  private store = new Map<string, StoredSession>();
  private totalCreated = 0;
  private totalDeleted = 0;

  async load(sessionId: string): Promise<BookingDraft> {
    const entry = this.store.get(sessionId);
    if (entry && entry.expiresAt > Date.now()) {
      // Refresh TTL on access
      entry.expiresAt = Date.now() + SESSION_TTL_MS;
      return entry.draft;
    }

    // Create new session
    const now = new Date().toISOString();
    const draft: BookingDraft = {
      sessionId,
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(sessionId, {
      draft,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    this.totalCreated++;
    return draft;
  }

  async save(sessionId: string, draft: BookingDraft): Promise<void> {
    const now = new Date().toISOString();
    const updated: BookingDraft = { ...draft, updatedAt: now };

    const existing = this.store.get(sessionId);
    this.store.set(sessionId, {
      draft: updated,
      expiresAt: existing
        ? existing.expiresAt
        : Date.now() + SESSION_TTL_MS,
    });
  }

  async delete(sessionId: string): Promise<void> {
    if (this.store.has(sessionId)) {
      this.store.delete(sessionId);
      this.totalDeleted++;
    }
  }

  async listSessions(): Promise<string[]> {
    this.evictExpired();
    return Array.from(this.store.keys());
  }

  async stats(): Promise<StateManagerStats> {
    this.evictExpired();
    return {
      activeSessions: this.store.size,
      totalCreated: this.totalCreated,
      totalDeleted: this.totalDeleted,
    };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(id);
        this.totalDeleted++;
      }
    }
  }
}

/** Singleton — shared across the process. */
export const stateManager: StateManager = new InMemoryStateManager();

/** Generate a new session ID. */
export function newSessionId(): string {
  return nanoid(21);
}
