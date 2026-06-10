import type {
  MemoryStore,
  MemoryStats,
  SessionMemory,
  TranscriptMessage,
} from "./memory-store.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory Memory Store
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_LENGTH = 20; // keep last N messages per session

export class InMemoryMemoryStore implements MemoryStore {
  private store = new Map<string, SessionMemory>();
  private totalPruned = 0;

  async read(sessionId: string): Promise<SessionMemory> {
    const existing = this.store.get(sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const fresh: SessionMemory = {
      sessionId,
      transcript: [],
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(sessionId, fresh);
    return fresh;
  }

  async write(sessionId: string, memory: SessionMemory): Promise<void> {
    const now = new Date().toISOString();
    this.store.set(sessionId, { ...memory, updatedAt: now });
  }

  async appendMessage(
    sessionId: string,
    message: TranscriptMessage
  ): Promise<void> {
    const memory = await this.read(sessionId);
    memory.transcript.push(message);
    memory.turnCount++;

    // Prune if over limit (keep most recent messages)
    if (memory.transcript.length > MAX_TRANSCRIPT_LENGTH) {
      const excess = memory.transcript.length - MAX_TRANSCRIPT_LENGTH;
      memory.transcript = memory.transcript.slice(excess);
      this.totalPruned += excess;
    }

    await this.write(sessionId, memory);
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  async stats(): Promise<MemoryStats> {
    const sessions = Array.from(this.store.values());
    const totalMessages = sessions.reduce(
      (sum, s) => sum + s.transcript.length,
      0
    );
    return {
      totalSessions: sessions.length,
      avgMessageCount: sessions.length > 0 ? totalMessages / sessions.length : 0,
      totalPruned: this.totalPruned,
    };
  }
}

/** Singleton. */
export const memoryStore: MemoryStore = new InMemoryMemoryStore();
