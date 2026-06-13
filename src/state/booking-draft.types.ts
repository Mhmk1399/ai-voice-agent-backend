// ─────────────────────────────────────────────────────────────────────────────
// Booking Draft — the in-progress reservation being built by the agent.
// This is the single source of truth for what the customer has said so far.
// ─────────────────────────────────────────────────────────────────────────────

export type GearType = "manual" | "automatic";

export type ReservationType = "Website" | "Office";

export interface PricePreview {
  totalPrice: number;
  currency: "GBP";
  days: number;
  extraHours: number;
  pricePerDay: number;
  gearExtraCost: number;
  pickupExtensionPrice: number;
  returnExtensionPrice: number;
  addOnsPrice: number;
  specialDaysPrice?: number;
  explanation: string;
}

export interface BookingAmbiguity {
  type: "category" | "office" | "date" | "other";
  message: string;
  options: string[];
}

export interface BookingDraftAddOn {
  addOnId: string;
  name: string;
  quantity: number;
  selectedTierIndex?: number;
}

export interface BookingDraft {
  sessionId: string;

  // Office
  officeId?: string;
  officeName?: string;

  // Category / vehicle type
  categoryId?: string;
  categoryName?: string;

  // Dates (raw text from customer + ISO resolved)
  pickupDateText?: string;
  returnDateText?: string;
  pickupDateISO?: string;
  returnDateISO?: string;

  // Booking details
  driverAge?: number;
  selectedGear?: GearType;

  // Gear resolution: set after driver age collected
  requiresGearSelection?: boolean;
  gearConfirmed?: boolean;

  // Add-ons (collected after price preview)
  addOns?: BookingDraftAddOn[];
  addOnsOffered?: boolean;
  addOnsConfirmed?: boolean;

  // Customer info (collected at confirmation stage)
  customerPhone?: string;
  customerName?: string;
  customerEmail?: string;
  customerVerified?: boolean;
  termsAccepted?: boolean;

  // Price preview (populated by calculatePricePreview tool)
  pricePreview?: PricePreview;

  // Ambiguity state (when resolver cannot confidently choose)
  ambiguity?: BookingAmbiguity;

  // Confirmation flags
  confirmed?: boolean;
  readyForReservation?: boolean;

  // Metadata
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export type RequiredBookingField =
  | "officeId"
  | "categoryId"
  | "pickupDateText"
  | "returnDateText"
  | "driverAge";

export const REQUIRED_BOOKING_FIELDS: RequiredBookingField[] = [
  "officeId",
  "categoryId",
  "pickupDateText",
  "returnDateText",
  "driverAge",
];

export function getMissingFields(draft: BookingDraft): RequiredBookingField[] {
  return REQUIRED_BOOKING_FIELDS.filter((f) => draft[f] == null);
}

export function isDraftReadyForConfirmation(draft: BookingDraft): boolean {
  return (
    getMissingFields(draft).length === 0 &&
    draft.pricePreview != null &&
    draft.confirmed !== true
  );
}

export function isDraftReadyForReservation(draft: BookingDraft): boolean {
  return (
    getMissingFields(draft).length === 0 &&
    draft.pricePreview != null &&
    draft.addOnsConfirmed === true &&
    draft.confirmed === true &&
    draft.customerName != null &&
    draft.customerPhone != null &&
    draft.customerVerified === true &&
    draft.termsAccepted === true
  );
}
