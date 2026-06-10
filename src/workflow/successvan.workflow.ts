import type { BookingDraft } from "../state/booking-draft.types.js";
import type { WorkflowStep, WorkflowState, WorkflowTransitionResult } from "./workflow.types.js";
import { getMissingFields } from "../state/booking-draft.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Workflow
// Determines the next step based on the current booking draft state.
// The LLM does NOT make workflow decisions — this is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

const STEP_QUESTIONS: Record<WorkflowStep, string> = {
  greeting: "Hello! I can help you book a van. Which type of van are you looking for?",
  collect_office: "Which office would you like to collect from?",
  collect_category: "Which type of van do you need?",
  collect_pickup_datetime: "What date and time should the rental start?",
  collect_return_datetime: "When will you return the van?",
  collect_driver_age: "How old is the driver?",
  resolve_ambiguity: "", // Dynamic — set by ambiguity resolver
  price_preview: "", // Dynamic — price is shown
  confirmation:
    "Would you like to confirm the booking?",
  ready_for_reservation:
    "Your booking is being created. Can I take your name and phone number?",
  human_handoff:
    "I'll connect you with our team right away. Please hold.",
  completed: "Your booking is complete. Thank you!",
};

// Maximum times we re-ask the same step question before flagging repetition
const MAX_QUESTION_REPEAT = 3;

export function determineNextStep(
  draft: BookingDraft,
  workflowState: WorkflowState
): WorkflowTransitionResult {
  const current = workflowState.currentStep;

  // Human handoff is terminal
  if (current === "human_handoff" || current === "completed") {
    return { nextStep: current };
  }

  // Ambiguity resolution: check if we're waiting for clarification
  if (draft.ambiguity && !workflowState.resolvedAmbiguity) {
    return {
      nextStep: "resolve_ambiguity",
      questionForUser: draft.ambiguity.message,
    };
  }

  // Collect required fields in order
  const missing = getMissingFields(draft);

  if (!draft.officeId) {
    return { nextStep: "collect_office", questionForUser: STEP_QUESTIONS.collect_office };
  }

  if (!draft.categoryId) {
    return { nextStep: "collect_category", questionForUser: STEP_QUESTIONS.collect_category };
  }

  if (!draft.pickupDateText) {
    return {
      nextStep: "collect_pickup_datetime",
      questionForUser: STEP_QUESTIONS.collect_pickup_datetime,
    };
  }

  if (!draft.returnDateText) {
    return {
      nextStep: "collect_return_datetime",
      questionForUser: STEP_QUESTIONS.collect_return_datetime,
    };
  }

  if (!draft.driverAge) {
    return {
      nextStep: "collect_driver_age",
      questionForUser: STEP_QUESTIONS.collect_driver_age,
    };
  }

  // All required fields collected — move to price preview if not done
  if (!draft.pricePreview) {
    return {
      nextStep: "price_preview",
      shouldCallPriceTool: true,
    };
  }

  // Price shown — ask for confirmation
  if (!draft.confirmed) {
    const summary = buildConfirmationSummary(draft);
    return {
      nextStep: "confirmation",
      questionForUser: summary,
    };
  }

  // Confirmed — collect customer info if missing
  if (!draft.customerName || !draft.customerPhone) {
    return {
      nextStep: "ready_for_reservation",
      questionForUser: STEP_QUESTIONS.ready_for_reservation,
    };
  }

  // Ready for reservation creation
  if (draft.readyForReservation) {
    return { nextStep: "completed" };
  }

  return {
    nextStep: "ready_for_reservation",
    questionForUser: STEP_QUESTIONS.ready_for_reservation,
  };
}

function buildConfirmationSummary(draft: BookingDraft): string {
  const lines: string[] = [];
  if (draft.officeName) lines.push(`Office: ${draft.officeName}`);
  if (draft.categoryName) lines.push(`Van: ${draft.categoryName}`);
  if (draft.pickupDateText) lines.push(`Pickup: ${draft.pickupDateText}`);
  if (draft.returnDateText) lines.push(`Return: ${draft.returnDateText}`);
  if (draft.driverAge) lines.push(`Driver age: ${draft.driverAge}`);
  if (draft.pricePreview) {
    lines.push(`Total: £${draft.pricePreview.totalPrice.toFixed(2)}`);
  }
  return lines.join(", ") + ". Shall I confirm this booking?";
}

export function createInitialWorkflowState(): WorkflowState {
  return {
    currentStep: "greeting",
    stepHistory: ["greeting"],
    questionAskedCount: {
      greeting: 0,
      collect_office: 0,
      collect_category: 0,
      collect_pickup_datetime: 0,
      collect_return_datetime: 0,
      collect_driver_age: 0,
      resolve_ambiguity: 0,
      price_preview: 0,
      confirmation: 0,
      ready_for_reservation: 0,
      human_handoff: 0,
      completed: 0,
    },
  };
}

export function advanceWorkflowState(
  state: WorkflowState,
  nextStep: WorkflowStep
): WorkflowState {
  const updated = { ...state };
  updated.previousStep = state.currentStep;
  updated.currentStep = nextStep;
  updated.stepHistory = [...state.stepHistory, nextStep];
  updated.questionAskedCount = {
    ...state.questionAskedCount,
    [nextStep]: (state.questionAskedCount[nextStep] ?? 0) + 1,
  };
  return updated;
}

export function isStepRepeated(
  state: WorkflowState,
  step: WorkflowStep
): boolean {
  return (state.questionAskedCount[step] ?? 0) >= MAX_QUESTION_REPEAT;
}
