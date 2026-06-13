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
  | "collect_gear"
  | "resolve_ambiguity"
  | "collect_add_ons"
  | "price_preview"
  | "confirmation"
  | "verify_customer"
  | "accept_terms"
  | "ready_for_pending_reservation"
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
