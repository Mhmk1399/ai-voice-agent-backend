import { randomUUID } from "node:crypto";
import type { ISessionStore } from "./session-store.interface.js";
import { InMemorySessionStore } from "./in-memory-session.store.js";
import type { VoiceSession, TurnRecord } from "./voice-session.types.js";
import type { BookingDraft } from "../agent/types/booking.types.js";

// Sessions expire after 30 minutes of inactivity.
// A real phone call rarely exceeds 10 minutes, so this is generous.
const SESSION_TTL_MS = 30 * 60 * 1000;

// Run session cleanup every 10 minutes.
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * VoiceSessionManager owns the full session lifecycle.
 *
 * Responsibilities:
 *   - Create sessions with unique IDs.
 *   - Load / save sessions through ISessionStore.
 *   - Advance session status per turn events.
 *   - Hold transient turn audio in memory (not persisted to the store).
 *   - Expire idle sessions via a background interval.
 *
 * ── Why are audio chunks stored separately? ──────────────────────────────────
 * Audio chunks are large raw Buffers that are only needed for the duration of
 * one recording turn. Storing them inside VoiceSession would:
 *   a) bloat the serialised session (important when moving to Redis), and
 *   b) require deserialising binary data on every session load.
 * Instead, they live in `turnChunks` (a Map keyed by sessionId) and are
 * discarded as soon as the turn is processed.
 *
 * ── Singleton pattern ────────────────────────────────────────────────────────
 * The exported `voiceSessionManager` singleton is shared by all WebSocket
 * connections in this process. In Fastify, route handlers run in the same
 * Node process, so sharing a module-level singleton is safe and idiomatic.
 */
export class VoiceSessionManager {
  private store: ISessionStore;

  /** Transient audio buffers for the current recording turn. */
  private turnChunks = new Map<string, Buffer[]>();

  /** MIME type of the current recording turn's audio. */
  private turnMimeTypes = new Map<string, string>();

  constructor(store?: ISessionStore) {
    this.store = store ?? new InMemorySessionStore();

    // Run prune on an interval. `.unref()` prevents this timer from keeping
    // the Node.js process alive if everything else has shut down.
    const timer = setInterval(() => {
      void this.store.prune(SESSION_TTL_MS);
    }, PRUNE_INTERVAL_MS);

    timer.unref();
  }

  // ── Session CRUD ────────────────────────────────────────────────────────────

  /** Create a brand-new session and persist it immediately. */
  async createSession(): Promise<VoiceSession> {
    const now = Date.now();
    const session: VoiceSession = {
      sessionId: randomUUID(),
      status: "idle",
      bookingDraft: {},
      turns: [],
      currentTurnId: null,
      lastActivityAt: now,
      createdAt: now,
    };

    await this.store.set(session);
    return session;
  }

  /**
   * Load a session by ID.
   * Returns null if the session does not exist or has exceeded TTL.
   * Expired sessions are deleted from the store.
   */
  async getSession(sessionId: string): Promise<VoiceSession | null> {
    const session = await this.store.get(sessionId);
    if (!session) return null;

    if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
      await this.store.delete(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Load an existing session by ID, or create a new one if not found / expired.
   *
   * This is the preferred entry point for HTTP tool routes (e.g. POST
   * /tools/process-booking-turn) where the caller may or may not have an
   * existing sessionId. Callers should always pass the returned session's
   * sessionId back on subsequent requests to continue the same conversation.
   *
   * @param sessionId - Optional. If provided, an attempt is made to load the
   *   existing session. If the session is missing or expired, a new one is
   *   created transparently (the caller should update its stored sessionId).
   */
  async getOrCreateSession(sessionId?: string): Promise<VoiceSession> {
    if (sessionId) {
      const existing = await this.getSession(sessionId);
      if (existing) return existing;
    }
    return this.createSession();
  }

  // ── Turn lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start a new recording turn on an existing session.
   * Assigns a fresh turn ID, advances status to "recording", and persists.
   *
   * This is "new turn in the same conversation" — not a new session.
   * The bookingDraft is untouched.
   */
  async beginTurn(session: VoiceSession): Promise<string> {
    const turnId = randomUUID();

    session.currentTurnId = turnId;
    session.status = "recording";
    session.lastActivityAt = Date.now();

    // Initialise the transient audio buffer for this session.
    this.turnChunks.set(session.sessionId, []);
    this.turnMimeTypes.set(session.sessionId, "audio/webm");

    await this.store.set(session);
    return turnId;
  }

  /** Append one audio chunk to the current turn's buffer. */
  addChunk(sessionId: string, chunk: Buffer, mimeType: string): void {
    const chunks = this.turnChunks.get(sessionId) ?? [];
    chunks.push(chunk);
    this.turnChunks.set(sessionId, chunks);
    this.turnMimeTypes.set(sessionId, mimeType);
  }

  /**
   * Take all accumulated audio buffers for a turn and clear the buffer.
   * Called once when `end_turn` is received.
   * After this call, addChunk will start a fresh buffer for the next turn.
   */
  consumeChunks(sessionId: string): { chunks: Buffer[]; mimeType: string } {
    const chunks = this.turnChunks.get(sessionId) ?? [];
    const mimeType = this.turnMimeTypes.get(sessionId) ?? "audio/webm";

    this.turnChunks.delete(sessionId);
    this.turnMimeTypes.delete(sessionId);

    return { chunks, mimeType };
  }

  /** Overwrite the booking draft and persist. Called after agent pipeline runs. */
  async updateDraft(session: VoiceSession, newDraft: BookingDraft): Promise<void> {
    session.bookingDraft = newDraft;
    session.lastActivityAt = Date.now();
    await this.store.set(session);
  }

  /**
   * Append a completed turn to session history and reset to idle.
   * Called after the full pipeline (transcription + agent + TTS) finishes.
   */
  async recordTurn(session: VoiceSession, record: TurnRecord): Promise<void> {
    session.turns.push(record);
    session.currentTurnId = null;
    session.status = "idle";
    session.lastActivityAt = Date.now();
    await this.store.set(session);
  }

  /** Update session status and persist. Used for intermediate states. */
  async setStatus(session: VoiceSession, status: VoiceSession["status"]): Promise<void> {
    session.status = status;
    session.lastActivityAt = Date.now();
    await this.store.set(session);
  }

  // ── Session termination ─────────────────────────────────────────────────────

  /**
   * End a session permanently. Called when the client sends `end_session`
   * or when the WebSocket connection closes after confirmation.
   */
  async endSession(sessionId: string): Promise<void> {
    this.turnChunks.delete(sessionId);
    this.turnMimeTypes.delete(sessionId);
    await this.store.delete(sessionId);
  }
}

/**
 * Singleton VoiceSessionManager shared across all WebSocket connections.
 *
 * To inject a different store (e.g. Redis), replace this with:
 *   export const voiceSessionManager = new VoiceSessionManager(new RedisSessionStore(...));
 */
export const voiceSessionManager = new VoiceSessionManager();
