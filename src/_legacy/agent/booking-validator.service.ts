import type { BookingDraft, BookingField } from "./types/booking.types.js";
import { getMissingBookingFields } from "./booking-draft.service.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; missingFields: BookingField[]; message: string };

// ──────────────────────────────────────────────────────────────────────────────
// Validators
// ──────────────────────────────────────────────────────────────────────────────

/** Check that all required booking fields are present. */
export function validateBookingDraft(draft: BookingDraft): ValidationResult {
  const missing = getMissingBookingFields(draft);

  if (missing.length === 0) return { valid: true };

  return {
    valid: false,
    missingFields: missing,
    message: `Missing fields: ${missing.join(", ")}`,
  };
}

/**
 * Validate driver age range.
 * UK van hire typically requires 21+ but some companies allow 18+.
 * Adjust the minimum as needed.
 */
export function validateDriverAge(age: number): boolean {
  return Number.isInteger(age) && age >= 18 && age <= 100;
}

/** Basic sanity check on date text — we don't parse, just ensure non-empty. */
export function validateDateText(text: string): boolean {
  return text.trim().length > 0;
}
