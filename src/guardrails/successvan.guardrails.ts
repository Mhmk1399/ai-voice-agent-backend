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
    const pricePattern = /£\s*\d+|\d+\s*(gbp|pounds?)/i;
    const hasPriceRef = pricePattern.test(ctx.response);
    if (!hasPriceRef || ctx.draft.pricePreview != null) {
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
  MULTIPLE_QUESTIONS_GUARD,
];
