import type { BookingDraft } from "../state/booking-draft.types.js";
import type { WorkflowState } from "../workflow/workflow.types.js";
import type { TurnTrace } from "../observability/metrics.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";
import type { ToolCall } from "../tools/tool.types.js";
import type { RuleResult } from "../rules/rule.types.js";
import type { GuardrailResult } from "../guardrails/guardrail.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Engine types — the contracts between all orchestration layers
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentTurnInput {
  sessionId?: string; // If omitted, a new session is created
  message: string;
  channel: "text" | "voice";
  isAdminMode?: boolean;
}

export interface AgentTurnOutput {
  sessionId: string;
  reply: string;
  bookingDraft: BookingDraft;
  workflowStep: string;
  missingFields: string[];
  toolCalls: ToolCall[];
  metrics: TurnTrace["metrics"];
  evaluation: {
    extractionAccuracy: number;
    ruleCompliance: number;
    taskProgress: number;
    responseQuality: number;
    humanHandoffRecommended: boolean;
    notes: string[];
  };
  trace: TurnTrace;
}

export interface AgentSessionDebug {
  sessionId: string;
  draft: BookingDraft;
  workflowState: WorkflowState;
  transcript: Array<{ role: string; content: string; timestamp: string }>;
  metrics: {
    turnCount: number;
    totalMs: number;
  };
}
