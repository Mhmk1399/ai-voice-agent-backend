import type { BookingDraft } from "../state/booking-draft.types.js";
import type { WorkflowStep, WorkflowState, WorkflowTransitionResult } from "./workflow.types.js";
import { getMissingFields } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

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
  collect_gear: "Would you prefer manual or automatic gearbox?",
  resolve_ambiguity: "", // Dynamic — set by ambiguity resolver
  collect_add_ons: "Would you like any add-ons, or continue without add-ons?",
  price_preview: "", // Dynamic — price is shown
  confirmation:
    "Would you like to confirm the booking?",
  verify_customer:
    "Can I take your name and phone number so we can verify the customer?",
  accept_terms:
    "Please confirm you accept the SuccessVan terms and conditions.",
  ready_for_pending_reservation:
    "All required details are ready for a pending website reservation.",
  human_handoff:
    "I'll connect you with our team right away. Please hold.",
  completed: "Your booking request is ready. Thank you!",
};

// Maximum times we re-ask the same step question before flagging repetition
const MAX_QUESTION_REPEAT = 3;

export function determineNextStep(
  draft: BookingDraft,
  workflowState: WorkflowState,
  context?: BusinessContext
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
    const offices = context?.offices ?? [];
    const list = offices.map((o) => `• ${o.name}`).join("\n");
    const question = list
      ? `Which office would you like to collect from?\n${list}`
      : STEP_QUESTIONS.collect_office;
    return { nextStep: "collect_office", questionForUser: question };
  }

  if (!draft.categoryId) {
    const categories = context?.categories ?? [];
    const list = categories.map((c) => `• ${c.name}`).join("\n");
    const question = list
      ? `Which type of van do you need?\n${list}`
      : STEP_QUESTIONS.collect_category;
    return { nextStep: "collect_category", questionForUser: question };
  }

  if (!draft.pickupDateText || !draft.pickupDateISO) {
    return {
      nextStep: "collect_pickup_datetime",
      questionForUser: draft.pickupDateText
        ? "What pickup time would you like?"
        : STEP_QUESTIONS.collect_pickup_datetime,
    };
  }

  if (!draft.returnDateText || !draft.returnDateISO) {
    return {
      nextStep: "collect_return_datetime",
      questionForUser: draft.returnDateText
        ? "What return time would you like?"
        : STEP_QUESTIONS.collect_return_datetime,
    };
  }

  if (!draft.driverAge) {
    return {
      nextStep: "collect_driver_age",
      questionForUser: STEP_QUESTIONS.collect_driver_age,
    };
  }

  if (needsGearSelection(draft, context) && !draft.selectedGear) {
    return {
      nextStep: "collect_gear",
      questionForUser: buildGearQuestion(draft, context),
    };
  }

  if (!draft.addOnsConfirmed) {
    return {
      nextStep: "collect_add_ons",
      questionForUser: buildAddOnsQuestion(context),
    };
  }

  // All price-impacting fields collected — move to price preview if not done
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

  // Confirmed — verify customer if missing
  if (!draft.customerName || !draft.customerPhone) {
    return {
      nextStep: "verify_customer",
      questionForUser: buildCustomerInfoQuestion(draft),
    };
  }

  if (!draft.customerVerified) {
    return {
      nextStep: "verify_customer",
      questionForUser:
        "Customer verification is required before booking. Has the customer completed phone verification?",
    };
  }

  if (!draft.termsAccepted) {
    return {
      nextStep: "accept_terms",
      questionForUser: STEP_QUESTIONS.accept_terms,
    };
  }

  if (!draft.readyForReservation) {
    return { nextStep: "ready_for_pending_reservation" };
  }

  return { nextStep: "completed" };
}

function needsGearSelection(
  draft: BookingDraft,
  context?: BusinessContext
): boolean {
  const category = context?.categories.find((c) => c.id === draft.categoryId);
  const types = category?.gear?.availableTypes ?? [];
  return types.includes("manual") && types.includes("automatic");
}

function buildGearQuestion(
  draft: BookingDraft,
  context?: BusinessContext
): string {
  const category = context?.categories.find((c) => c.id === draft.categoryId);
  const types = category?.gear?.availableTypes ?? [];
  const label = types.length > 0 ? types.join(" or ") : "manual or automatic";
  return `This van is available as ${label}. Which gearbox would you prefer?`;
}

function buildAddOnsQuestion(context?: BusinessContext): string {
  const addOns = context?.addOns ?? [];
  if (addOns.length === 0) {
    return "There are no add-ons currently loaded. Shall we continue without add-ons?";
  }

  const list = addOns
    .slice(0, 8)
    .map((a) => `• ${a.name}${formatAddOnPrice(a)}`)
    .join("\n");
  return `Would you like any add-ons?\n${list}\nYou can also say no add-ons.`;
}

function formatAddOnPrice(addOn: NonNullable<BusinessContext["addOns"]>[number]): string {
  if (addOn.pricingType === "flat" && addOn.flatPrice) {
    return ` (£${addOn.flatPrice.amount.toFixed(2)}${addOn.flatPrice.isPerDay ? "/day" : ""})`;
  }
  if (addOn.pricingType === "tiered") return " (tiered price)";
  return "";
}

function buildCustomerInfoQuestion(draft: BookingDraft): string {
  if (!draft.customerName && !draft.customerPhone) {
    return "Can I take your name and phone number?";
  }
  if (!draft.customerName) {
    return "Can I take your name?";
  }
  if (!draft.customerPhone) {
    return "Can I take your phone number?";
  }
  return "I have your name and phone number. I can pass this to our booking team to complete verification and terms.";
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
      collect_gear: 0,
      resolve_ambiguity: 0,
      collect_add_ons: 0,
      price_preview: 0,
      confirmation: 0,
      verify_customer: 0,
      accept_terms: 0,
      ready_for_pending_reservation: 0,
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
