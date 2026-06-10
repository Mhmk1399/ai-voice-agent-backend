/**
 * @deprecated
 * This module is kept for backward compatibility with the legacy booking-agent.service.ts.
 *
 * New code should use:
 *   - booking-draft.service.ts    → getMissingBookingFields, mergeBookingDraft
 *   - booking-question.service.ts → getQuestionForField, buildConfirmationMessage
 *   - booking-validator.service.ts → validateBookingDraft
 */
import type { BookingDraft, BookingField } from "./types/booking.types.js";

export const REQUIRED_BOOKING_FIELDS: BookingField[] = [
  "officeId",
  "categoryId",
  "startDateText",
  "endDateText",
  "driverAge",
];

export function getMissingBookingFields(state: BookingDraft): BookingField[] {
  return REQUIRED_BOOKING_FIELDS.filter((field) => {
    const value = state[field];

    if (value === undefined || value === null) return true;
    if (typeof value === "string" && value.trim().length === 0) return true;

    return false;
  });
}

export function mergeBookingDraft(
  oldState: BookingDraft,
  newState: BookingDraft
): BookingDraft {
  return {
    ...oldState,
    ...Object.fromEntries(
      Object.entries(newState).filter(([, value]) => {
        if (value === undefined || value === null) return false;
        if (typeof value === "string" && value.trim().length === 0) return false;
        if (Array.isArray(value) && value.length === 0) return false;
        return true;
      })
    ),
  };
}

export function getQuestionForField(field: BookingField): string {
  switch (field) {
    case "officeId":
      return "Which office would you like to collect the van from?";
    case "categoryId":
      return "Which van category would you like? For example small van, medium van, large van, Luton van, or minibus.";
    case "startDateText":
      return "What date and time would you like to pick up the van?";
    case "endDateText":
      return "What date and time would you like to return it?";
    case "driverAge":
      return "How old is the driver?";
    default:
      return "Could you give me the next booking detail?";
  }
}