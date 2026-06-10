import type { BookingDraft } from "../state/booking-draft.types.js";
import type { WorkflowState } from "./workflow.types.js";
import {
  determineNextStep,
  advanceWorkflowState,
  isStepRepeated,
} from "./successvan.workflow.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Runner
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowRunResult {
  workflowState: WorkflowState;
  nextQuestion?: string;
  shouldCallPriceTool: boolean;
  stepRepeated: boolean;
  isTerminal: boolean;
}

export function runWorkflow(
  draft: BookingDraft,
  workflowState: WorkflowState,
  _context: BusinessContext
): WorkflowRunResult {
  const transition = determineNextStep(draft, workflowState);
  const nextStep = transition.nextStep;

  const isTerminal =
    nextStep === "human_handoff" ||
    nextStep === "completed";

  const stepRepeated = isStepRepeated(workflowState, nextStep);

  const updatedState = advanceWorkflowState(workflowState, nextStep);

  return {
    workflowState: updatedState,
    nextQuestion: transition.questionForUser,
    shouldCallPriceTool: transition.shouldCallPriceTool ?? false,
    stepRepeated,
    isTerminal,
  };
}
