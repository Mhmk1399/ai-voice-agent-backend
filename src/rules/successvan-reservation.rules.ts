import type { Rule, RuleResult } from "./rule.types.js";
import type { BookingDraft } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Reservation Submission Rules
// Matches RESERVATION_RULES.md customer/admin validation rules.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReservationRuleContext {
  draft: BookingDraft;
  context: BusinessContext;
  isAdminMode?: boolean;
  nowLondon?: Date; // injected for testability
}

function getLondonNow(ctx: ReservationRuleContext): Date {
  return ctx.nowLondon ?? new Date(
    new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })
  );
}

function getRuleResult(
  ruleId: string,
  severity: "hard" | "soft",
  passed: boolean,
  message?: string
): RuleResult {
  return { ruleId, severity, passed, message: passed ? undefined : message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer date lead time
// Before 16:00 London → earliest pickup is tomorrow.
// At or after 16:00 London → earliest pickup is day after tomorrow.
// ─────────────────────────────────────────────────────────────────────────────

export const CUSTOMER_LEAD_TIME_RULE: Rule<ReservationRuleContext> = {
  id: "CUSTOMER_LEAD_TIME",
  severity: "hard",
  description: "Customer pickup must respect London-time lead time rules.",
  check(ctx): RuleResult {
    if (ctx.isAdminMode) return getRuleResult(this.id, this.severity, true);

    const pickup = ctx.draft.pickupDateISO
      ? new Date(ctx.draft.pickupDateISO)
      : null;
    if (!pickup) return getRuleResult(this.id, this.severity, true); // Not set yet — skip

    const londonNow = getLondonNow(ctx);
    const londonHour = londonNow.getHours();
    const minLeadDays = londonHour < 16 ? 1 : 2;

    const minPickup = new Date(londonNow);
    minPickup.setDate(minPickup.getDate() + minLeadDays);
    minPickup.setHours(0, 0, 0, 0);

    const pickupDay = new Date(pickup);
    pickupDay.setHours(0, 0, 0, 0);

    const passed = pickupDay >= minPickup;
    return getRuleResult(
      this.id,
      this.severity,
      passed,
      `Pickup too soon. Earliest pickup is ${minLeadDays === 1 ? "tomorrow" : "the day after tomorrow"} (London time).`
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Short-rental pricing
// Less than 24 hours is allowed and billed as one full day by pricing.
// ─────────────────────────────────────────────────────────────────────────────

export const SAME_DAY_MIN_DURATION_RULE: Rule<ReservationRuleContext> = {
  id: "SAME_DAY_MIN_DURATION",
  severity: "soft",
  description: "Short rentals are allowed and billed as one full day.",
  check(ctx): RuleResult {
    return getRuleResult(this.id, this.severity, true);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Driver age rules
// ─────────────────────────────────────────────────────────────────────────────

export const DRIVER_AGE_RULE: Rule<ReservationRuleContext> = {
  id: "DRIVER_AGE",
  severity: "hard",
  description: "Driver age must be within allowed range for the category.",
  check(ctx): RuleResult {
    const age = ctx.draft.driverAge;
    if (age == null) return getRuleResult(this.id, this.severity, true); // Not collected yet

    const category = ctx.context.categories.find(
      (c) => c.id === ctx.draft.categoryId
    );
    const minAge = category?.minDriverAge ?? 23;
    const maxAge = 80;

    if (age < minAge) {
      return getRuleResult(
        this.id,
        this.severity,
        false,
        `Driver age ${age} is below minimum ${minAge} for this vehicle type.`
      );
    }
    if (age > maxAge) {
      return getRuleResult(
        this.id,
        this.severity,
        false,
        `Driver age ${age} exceeds maximum allowed age of ${maxAge}.`
      );
    }
    return getRuleResult(this.id, this.severity, true);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Customer authentication required before final submission
// ─────────────────────────────────────────────────────────────────────────────

export const AUTHENTICATION_REQUIRED_RULE: Rule<ReservationRuleContext> = {
  id: "AUTHENTICATION_REQUIRED",
  severity: "hard",
  description: "Customer must be identified before reservation creation.",
  check(ctx): RuleResult {
    if (ctx.isAdminMode) return getRuleResult(this.id, this.severity, true);
    if (!ctx.draft.readyForReservation) return getRuleResult(this.id, this.severity, true);
    const passed = ctx.draft.customerPhone != null && ctx.draft.customerName != null;
    return getRuleResult(
      this.id,
      this.severity,
      passed,
      "Customer name and phone are required before creating a reservation."
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UK phone number format
// ─────────────────────────────────────────────────────────────────────────────

export const PHONE_FORMAT_RULE: Rule<ReservationRuleContext> = {
  id: "PHONE_FORMAT",
  severity: "hard",
  description: "Customer phone must be SuccessVan's 10-digit UK local format without +44.",
  check(ctx): RuleResult {
    const phone = ctx.draft.customerPhone;
    if (!phone) return getRuleResult(this.id, this.severity, true);
    const digits = phone.replace(/\D/g, "");
    const passed = digits.length === 10;
    return getRuleResult(
      this.id,
      this.severity,
      passed,
      `Phone number must be a 10-digit UK number without +44 (got: ${phone}).`
    );
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Admin manual price > 0
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_MANUAL_PRICE_RULE: Rule<ReservationRuleContext & { manualPricePerDay?: number }> = {
  id: "ADMIN_MANUAL_PRICE",
  severity: "hard",
  description: "Admin manual price per day must be greater than 0.",
  check(ctx): RuleResult {
    if (!ctx.isAdminMode) return getRuleResult(this.id, this.severity, true);
    const price = (ctx as any).manualPricePerDay;
    if (price == null) return getRuleResult(this.id, this.severity, true);
    const passed = typeof price === "number" && price > 0;
    return getRuleResult(
      this.id,
      this.severity,
      passed,
      `Manual price per day must be greater than 0 (got: ${price}).`
    );
  },
};

export const successVanReservationRules: Rule<ReservationRuleContext>[] = [
  CUSTOMER_LEAD_TIME_RULE,
  SAME_DAY_MIN_DURATION_RULE,
  DRIVER_AGE_RULE,
  AUTHENTICATION_REQUIRED_RULE,
  PHONE_FORMAT_RULE,
];
