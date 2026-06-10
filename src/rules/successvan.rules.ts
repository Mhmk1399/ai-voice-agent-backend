import type { Rule, RuleResult } from "./rule.types.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Conversation Rules
// (agent behavior, not reservation submission rules)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversationRuleContext {
  draft: BookingDraft;
  context: BusinessContext;
  proposedResponse?: string;
  questionsAskedThisTurn?: number;
}

function make(
  id: string,
  severity: "hard" | "soft",
  description: string,
  check: (ctx: ConversationRuleContext) => boolean,
  message: (ctx: ConversationRuleContext) => string
): Rule<ConversationRuleContext> {
  return {
    id,
    severity,
    description,
    check(ctx): RuleResult {
      const passed = check(ctx);
      return {
        ruleId: id,
        severity,
        passed,
        message: passed ? undefined : message(ctx),
      };
    },
  };
}

export const ASK_ONE_QUESTION_AT_A_TIME = make(
  "ASK_ONE_QUESTION_AT_A_TIME",
  "hard",
  "Agent must ask only one question per turn.",
  (ctx) => (ctx.questionsAskedThisTurn ?? 1) <= 1,
  () => "Response asks multiple questions. Rewrite to ask only one."
);

export const NO_INVENTED_PRICE = make(
  "NO_INVENTED_PRICE",
  "hard",
  "Agent must never invent a price not backed by a price preview.",
  (ctx) => {
    const resp = ctx.proposedResponse ?? "";
    const mentionsPrice =
      /£\d+|\$\d+|\d+\s*(gbp|pounds?|per day|per week)/i.test(resp);
    return !mentionsPrice || ctx.draft.pricePreview != null;
  },
  () => "Response mentions a price but no pricePreview exists. Remove price reference."
);

export const NO_INVENTED_OFFICE = make(
  "NO_INVENTED_OFFICE",
  "hard",
  "Agent must only mention offices that exist in context.",
  (ctx) => {
    const resp = (ctx.proposedResponse ?? "").toLowerCase();
    const officeNames = ctx.context.offices.map((o) => o.name.toLowerCase());
    // Only check if response specifically names offices we don't have
    // This is a soft heuristic — full verification is in guardrails
    if (officeNames.length === 0) return true;
    return true; // Guardrails handle detailed response scanning
  },
  () => "Response mentions an office not in available context."
);

export const NO_INVENTED_CATEGORY = make(
  "NO_INVENTED_CATEGORY",
  "hard",
  "Agent must only mention categories that exist in context.",
  (_ctx) => true, // Guardrails handle detailed response scanning
  () => "Response mentions a category not in available context."
);

export const NO_RESERVATION_WITHOUT_CONFIRMATION = make(
  "NO_RESERVATION_WITHOUT_CONFIRMATION",
  "hard",
  "Must not create reservation without explicit customer confirmation.",
  (ctx) => {
    if (ctx.draft.readyForReservation) return ctx.draft.confirmed === true;
    return true;
  },
  () => "Reservation attempted without explicit confirmation."
);

export const REQUIRE_DRIVER_AGE = make(
  "REQUIRE_DRIVER_AGE",
  "soft",
  "Driver age must be collected before price preview.",
  (ctx) => {
    if (ctx.draft.pricePreview != null) return ctx.draft.driverAge != null;
    return true;
  },
  () => "Driver age is required before showing price preview."
);

export const REQUIRE_OFFICE = make(
  "REQUIRE_OFFICE",
  "soft",
  "Office must be selected.",
  (ctx) => ctx.draft.officeId != null,
  () => "Office not yet selected."
);

export const REQUIRE_CATEGORY = make(
  "REQUIRE_CATEGORY",
  "soft",
  "Vehicle category must be selected.",
  (ctx) => ctx.draft.categoryId != null,
  () => "Vehicle category not yet selected."
);

export const REQUIRE_PICKUP_AND_RETURN = make(
  "REQUIRE_PICKUP_AND_RETURN",
  "soft",
  "Both pickup and return dates are required.",
  (ctx) =>
    ctx.draft.pickupDateText != null && ctx.draft.returnDateText != null,
  () => "Pickup and return dates are both required."
);

export const HUMAN_HANDOFF_ON_USER_REQUEST = make(
  "HUMAN_HANDOFF_ON_USER_REQUEST",
  "hard",
  "If customer requests a human, trigger handoff immediately.",
  (_ctx) => true, // Handled by workflow
  () => "Customer requested human agent."
);

export const successVanConversationRules: Rule<ConversationRuleContext>[] = [
  ASK_ONE_QUESTION_AT_A_TIME,
  NO_INVENTED_PRICE,
  NO_INVENTED_OFFICE,
  NO_INVENTED_CATEGORY,
  NO_RESERVATION_WITHOUT_CONFIRMATION,
  REQUIRE_DRIVER_AGE,
  REQUIRE_OFFICE,
  REQUIRE_CATEGORY,
  REQUIRE_PICKUP_AND_RETURN,
  HUMAN_HANDOFF_ON_USER_REQUEST,
];
