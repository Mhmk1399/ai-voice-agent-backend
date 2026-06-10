// ─────────────────────────────────────────────────────────────────────────────
// Workflow Types
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowStep =
  | "greeting"
  | "collect_office"
  | "collect_category"
  | "collect_pickup_datetime"
  | "collect_return_datetime"
  | "collect_driver_age"
  | "resolve_ambiguity"
  | "price_preview"
  | "confirmation"
  | "ready_for_reservation"
  | "human_handoff"
  | "completed";

export interface WorkflowState {
  currentStep: WorkflowStep;
  previousStep?: WorkflowStep;
  stepHistory: WorkflowStep[];
  questionAskedCount: Record<WorkflowStep, number>;
  resolvedAmbiguity?: boolean;
}

export interface WorkflowTransitionResult {
  nextStep: WorkflowStep;
  questionForUser?: string;
  shouldCallPriceTool?: boolean;
}
