// ─────────────────────────────────────────────────────────────────────────────
// Channel Types
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelType = "text" | "voice" | "realtime";

export interface ChannelMessage {
  sessionId?: string;
  content: string;
  channel: ChannelType;
  metadata?: Record<string, unknown>;
}
