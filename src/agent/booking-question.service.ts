import type { BookingDraft, BookingField } from "./types/booking.types.js";

/**
 * One short question per missing booking field.
 *
 * Keep responses brief — this is read aloud by TTS on a phone call.
 * Aim for < 15 words per question.
 */
export function getQuestionForField(field: BookingField): string {
  switch (field) {
    case "officeId":
      return "Which office would you like to collect the van from?";
    case "categoryId":
      return "Which van type would you like? For example small, medium, large, Luton, or minibus.";
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

/**
 * Build a short confirmation summary from the completed booking draft.
 *
 * This is read aloud before the user confirms. Keep it under 60 words.
 * Pricing will be calculated later when a real Reservation is created.
 */
export function buildConfirmationMessage(draft: BookingDraft): string {
  const lines: string[] = ["Here is what I have:"];

  if (draft.officeName) lines.push(`Office: ${draft.officeName}.`);
  if (draft.categoryName) lines.push(`Van: ${draft.categoryName}.`);
  if (draft.startDateText) lines.push(`Pickup: ${draft.startDateText}.`);
  if (draft.endDateText) lines.push(`Return: ${draft.endDateText}.`);
  if (draft.driverAge) lines.push(`Driver age: ${draft.driverAge}.`);
  if (draft.selectedGear) lines.push(`Gearbox: ${draft.selectedGear}.`);

  lines.push("Shall I confirm this booking?");

  return lines.join(" ");
}
