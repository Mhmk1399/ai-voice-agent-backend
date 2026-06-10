import type { BookingDraft, BookingField } from "./types/booking.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Required fields
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Minimum fields needed before we can build a reservation.
 * Everything else (addOns, gear, phone, name) is optional or collected later.
 */
export const REQUIRED_BOOKING_FIELDS: BookingField[] = [
  "officeId",
  "categoryId",
  "startDateText",
  "endDateText",
  "driverAge",
];

// ──────────────────────────────────────────────────────────────────────────────
// Field inspection
// ──────────────────────────────────────────────────────────────────────────────

/** Return the list of required fields that are still empty or missing. */
export function getMissingBookingFields(draft: BookingDraft): BookingField[] {
  return REQUIRED_BOOKING_FIELDS.filter((field) => {
    const value = draft[field];
    if (value === undefined || value === null) return true;
    if (typeof value === "string" && value.trim().length === 0) return true;
    return false;
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Draft merging
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Merge newData into existingDraft, skipping null / empty values.
 *
 * Existing fields are ONLY overwritten if newData supplies a non-empty value.
 * This ensures that a GPT response returning `{}` for a field does not
 * accidentally erase what the user already said in a previous turn.
 */
export function mergeBookingDraft(
  existingDraft: BookingDraft,
  newData: Partial<BookingDraft>
): BookingDraft {
  const filtered = Object.fromEntries(
    Object.entries(newData).filter(([, v]) => {
      if (v === undefined || v === null) return false;
      if (typeof v === "string" && v.trim().length === 0) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    })
  );

  return { ...existingDraft, ...filtered };
}
