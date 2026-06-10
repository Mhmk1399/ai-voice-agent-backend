// ─────────────────────────────────────────────────────────────────────────────
// Memory Store Interface
// Stores per-session conversation transcript and short-term context.
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO
}

export interface SessionMemory {
  sessionId: string;
  transcript: TranscriptMessage[];
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryStore {
  read(sessionId: string): Promise<SessionMemory>;
  write(sessionId: string, memory: SessionMemory): Promise<void>;
  appendMessage(sessionId: string, message: TranscriptMessage): Promise<void>;
  delete(sessionId: string): Promise<void>;
  stats(): Promise<MemoryStats>;
}

export interface MemoryStats {
  totalSessions: number;
  avgMessageCount: number;
  totalPruned: number;
}
