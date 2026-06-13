import type { Guardrail, GuardrailContext, GuardrailResult } from "./guardrail.types.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Guardrails
// Final checks on the agent response before returning to the client.
// ─────────────────────────────────────────────────────────────────────────────

export interface SuccessVanGuardrailContext extends GuardrailContext {
  draft: BookingDraft;
  context: BusinessContext;
}

function make(
  id: string,
  description: string,
  check: (ctx: SuccessVanGuardrailContext) => GuardrailResult
): Guardrail<SuccessVanGuardrailContext> {
  return { id, description, check };
}

// ── Invented price guard ──────────────────────────────────────────────────────

export const INVENTED_PRICE_GUARD = make(
  "INVENTED_PRICE_GUARD",
  "Block/rewrite responses that mention a price without a price preview.",
  (ctx): GuardrailResult => {
    if (/£\s*calculating|price is calculating|total is calculating/i.test(ctx.response)) {
      return {
        guardrailId: "INVENTED_PRICE_GUARD",
        passed: false,
        blocked: true,
        reason: "Response exposed a placeholder price.",
        rewrite:
          "I need valid pickup and return dates before I can calculate the price. What pickup and return date and time would you like?",
      };
    }

    const pricePattern = /£\s*\d+|\d+\s*(gbp|pounds?)/i;
    const hasPriceRef = pricePattern.test(ctx.response);
    if (!hasPriceRef || ctx.draft.pricePreview != null) {
      return { guardrailId: "INVENTED_PRICE_GUARD", passed: true, blocked: false };
    }
    if (isAllowedContextPrice(ctx)) {
      return { guardrailId: "INVENTED_PRICE_GUARD", passed: true, blocked: false };
    }
    return {
      guardrailId: "INVENTED_PRICE_GUARD",
      passed: false,
      blocked: true,
      reason: "Response mentions price but no pricePreview exists.",
      rewrite:
        "I'll work out the price once I have all the details. Let me continue.",
    };
  }
);

function isAllowedContextPrice(ctx: SuccessVanGuardrailContext): boolean {
  const lower = ctx.response.toLowerCase();
  const claimsFinalRentalPrice =
    lower.includes("estimated total") ||
    lower.includes("total is") ||
    lower.includes("total:") ||
    lower.includes("rental price") ||
    lower.includes("booking price") ||
    lower.includes("quote is") ||
    lower.includes("price is");

  if (claimsFinalRentalPrice) return false;

  const mentionsKnownAddOn = ctx.context.addOns.some((addOn) =>
    addOn.name && lower.includes(addOn.name.toLowerCase())
  );
  const mentionsPolicyFee =
    lower.includes("add-on") ||
    lower.includes("available add-ons") ||
    lower.includes("extension") ||
    lower.includes("special day") ||
    lower.includes("special-day") ||
    lower.includes("automatic gear") ||
    lower.includes("charge:");

  return mentionsKnownAddOn || mentionsPolicyFee;
}

// ── Invented office guard ─────────────────────────────────────────────────────

export const INVENTED_OFFICE_GUARD = make(
  "INVENTED_OFFICE_GUARD",
  "Block responses that mention offices not in context.",
  (ctx): GuardrailResult => {
    const response = ctx.response.toLowerCase();
    const knownNames = ctx.context.offices.map((o) => o.name.toLowerCase());

    // Extract quoted office names or proper-noun-like references
    const officeMatches = response.match(
      /(?:from|at|in|office[:\s]+)([A-Z][a-z]+(?: [A-Z][a-z]+)*)/g
    );
    if (!officeMatches) {
      return { guardrailId: "INVENTED_OFFICE_GUARD", passed: true, blocked: false };
    }

    // If all mentioned offices are in context, pass
    for (const match of officeMatches) {
      const candidate = match.toLowerCase().replace(/^(from|at|in|office:?\s*)/, "").trim();
      const found = knownNames.some(
        (n) => n.includes(candidate) || candidate.includes(n.split(" ")[0])
      );
      if (!found) {
        return {
          guardrailId: "INVENTED_OFFICE_GUARD",
          passed: false,
          blocked: true,
          reason: `Response mentions unknown office reference: "${candidate}"`,
          rewrite: ctx.response.replace(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)* office\b/g, "our office"),
        };
      }
    }

    return { guardrailId: "INVENTED_OFFICE_GUARD", passed: true, blocked: false };
  }
);

// ── Reservation without confirmation guard ────────────────────────────────────

export const RESERVATION_WITHOUT_CONFIRMATION_GUARD = make(
  "RESERVATION_WITHOUT_CONFIRMATION_GUARD",
  "Block responses claiming reservation is created when not confirmed.",
  (ctx): GuardrailResult => {
    const creationPhrases = [
      "reservation has been created",
      "booking has been confirmed",
      "booking is confirmed",
      "reservation is confirmed",
      "booking created",
    ];
    const lower = ctx.response.toLowerCase();
    const claimsCreation = creationPhrases.some((p) => lower.includes(p));

    if (claimsCreation && ctx.draft.readyForReservation !== true) {
      return {
        guardrailId: "RESERVATION_WITHOUT_CONFIRMATION_GUARD",
        passed: false,
        blocked: true,
        reason: "Response claims booking is created but readyForReservation is false.",
        rewrite:
          "I have all the details. Shall I go ahead and confirm this booking?",
      };
    }

    return { guardrailId: "RESERVATION_WITHOUT_CONFIRMATION_GUARD", passed: true, blocked: false };
  }
);

// ── Real SuccessVan workflow guard ───────────────────────────────────────────

export const SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD = make(
  "SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD",
  "Block responses claiming reservation readiness before real SuccessVan steps are complete.",
  (ctx): GuardrailResult => {
    const lower = ctx.response.toLowerCase();
    const claimsReady =
      lower.includes("booking request is ready") ||
      lower.includes("reservation is ready") ||
      lower.includes("prepare the pending") ||
      lower.includes("all required details are collected") ||
      lower.includes("booking details are confirmed");

    if (!claimsReady) {
      return {
        guardrailId: "SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD",
        passed: true,
        blocked: false,
      };
    }

    const missing: string[] = [];
    if (!ctx.draft.addOnsConfirmed) missing.push("add-ons accepted or skipped");
    if (!ctx.draft.pricePreview) missing.push("final price calculated");
    if (!ctx.draft.confirmed) missing.push("customer confirmation");
    if (!ctx.draft.customerName || !ctx.draft.customerPhone) missing.push("customer name and phone");
    if (!ctx.draft.customerVerified) missing.push("phone verification");
    if (!ctx.draft.termsAccepted) missing.push("terms acceptance");

    if (missing.length === 0) {
      return {
        guardrailId: "SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD",
        passed: true,
        blocked: false,
      };
    }

    return {
      guardrailId: "SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD",
      passed: false,
      blocked: true,
      reason: `Missing required SuccessVan steps: ${missing.join(", ")}`,
      rewrite: `Before I can prepare the pending reservation, I still need: ${missing.join(", ")}.`,
    };
  }
);

// ── Multiple questions guard ──────────────────────────────────────────────────

export const MULTIPLE_QUESTIONS_GUARD = make(
  "MULTIPLE_QUESTIONS_GUARD",
  "Rewrite responses that ask more than one question.",
  (ctx): GuardrailResult => {
    const questionMarks = (ctx.response.match(/\?/g) ?? []).length;
    if (questionMarks <= 1) {
      return { guardrailId: "MULTIPLE_QUESTIONS_GUARD", passed: true, blocked: false };
    }

    // Keep only the first sentence that ends with ?
    const firstQuestion = ctx.response
      .split(/(?<=[.!?])\s+/)
      .find((s) => s.includes("?"));

    return {
      guardrailId: "MULTIPLE_QUESTIONS_GUARD",
      passed: false,
      blocked: false, // soft — rewrite rather than block
      reason: "Response asks multiple questions.",
      rewrite: firstQuestion ?? ctx.response,
    };
  }
);

export const successVanGuardrails: Guardrail<SuccessVanGuardrailContext>[] = [
  INVENTED_PRICE_GUARD,
  INVENTED_OFFICE_GUARD,
  RESERVATION_WITHOUT_CONFIRMATION_GUARD,
  SUCCESSVAN_WORKFLOW_COMPLETENESS_GUARD,
  MULTIPLE_QUESTIONS_GUARD,
];
