import type { TurnTrace } from "./metrics.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Service
// Scores a completed turn against quality dimensions.
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluationResult {
  extractionAccuracy: number; // 0-1
  ruleCompliance: number; // 0-1
  taskProgress: number; // 0-1
  responseQuality: number; // 0-1
  humanHandoffRecommended: boolean;
  notes: string[];
}

export function evaluateTurn(trace: TurnTrace): EvaluationResult {
  const notes: string[] = [];
  let extractionAccuracy = 1.0;
  let ruleCompliance = 1.0;
  let taskProgress = 0.0;
  let responseQuality = 1.0;
  let humanHandoffRecommended = false;

  // Extraction accuracy: penalize for LLM parse errors
  const parseErrors = trace.llmCalls.filter((c) => c.parseError).length;
  if (parseErrors > 0) {
    extractionAccuracy -= parseErrors * 0.2;
    notes.push(`${parseErrors} LLM parse error(s) in turn.`);
  }

  // Rule compliance: penalize for hard violations
  const hardViolations = trace.rulesChecked.filter(
    (r) => !r.passed && r.severity === "hard"
  ).length;
  if (hardViolations > 0) {
    ruleCompliance -= hardViolations * 0.3;
    notes.push(`${hardViolations} hard rule violation(s).`);
  }

  // Task progress: evaluate workflow advancement
  const stepsBefore = getStepIndex(trace.workflowStepBefore);
  const stepsAfter = getStepIndex(trace.workflowStepAfter);
  if (stepsAfter > stepsBefore) {
    taskProgress = Math.min(1, (stepsAfter - stepsBefore) * 0.2);
  } else if (stepsAfter === stepsBefore) {
    taskProgress = 0.1; // stayed on same step — partial progress
    notes.push("Workflow step did not advance.");
  }

  // Response quality: penalize for guardrail rewrites
  const blockedGuardrails = trace.guardrailsChecked.filter(
    (g) => g.blocked
  ).length;
  if (blockedGuardrails > 0) {
    responseQuality -= blockedGuardrails * 0.25;
    notes.push(`${blockedGuardrails} guardrail block(s).`);
  }

  // Human handoff recommendation
  if (
    trace.workflowStepAfter === "human_handoff" ||
    trace.errors.length >= 3
  ) {
    humanHandoffRecommended = true;
    notes.push("Human handoff recommended.");
  }

  return {
    extractionAccuracy: Math.max(0, Math.min(1, extractionAccuracy)),
    ruleCompliance: Math.max(0, Math.min(1, ruleCompliance)),
    taskProgress: Math.max(0, Math.min(1, taskProgress)),
    responseQuality: Math.max(0, Math.min(1, responseQuality)),
    humanHandoffRecommended,
    notes,
  };
}

const STEP_ORDER: Record<string, number> = {
  greeting: 0,
  collect_office: 1,
  collect_category: 2,
  collect_pickup_datetime: 3,
  collect_return_datetime: 4,
  collect_driver_age: 5,
  resolve_ambiguity: 3.5,
  collect_gear: 6,
  collect_add_ons: 7,
  price_preview: 8,
  confirmation: 9,
  verify_customer: 10,
  accept_terms: 11,
  ready_for_pending_reservation: 12,
  completed: 13,
  human_handoff: 14,
};

function getStepIndex(step: string): number {
  return STEP_ORDER[step] ?? 0;
}
