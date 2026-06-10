import type { BookingDraft } from "../state/booking-draft.types.js";
import type { BusinessContext } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reservation Payload Validator
// Validates the final payload before creating a reservation.
// Centralizes all rules that the frontend was previously enforcing.
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export interface PayloadValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateReservationPayload(
  draft: BookingDraft,
  context: BusinessContext,
  isAdminMode = false
): PayloadValidationResult {
  const errors: ValidationError[] = [];

  // Required fields
  if (!draft.officeId) {
    errors.push({ field: "officeId", message: "Office is required." });
  }
  if (!draft.categoryId) {
    errors.push({ field: "categoryId", message: "Vehicle category is required." });
  }
  if (!draft.pickupDateISO) {
    errors.push({ field: "pickupDateISO", message: "Pickup date/time is required." });
  }
  if (!draft.returnDateISO) {
    errors.push({ field: "returnDateISO", message: "Return date/time is required." });
  }
  if (!draft.driverAge) {
    errors.push({ field: "driverAge", message: "Driver age is required." });
  }

  // Confirm dates parse correctly
  let pickupDate: Date | null = null;
  let returnDate: Date | null = null;

  if (draft.pickupDateISO) {
    pickupDate = new Date(draft.pickupDateISO);
    if (isNaN(pickupDate.getTime())) {
      errors.push({ field: "pickupDateISO", message: "Invalid pickup date." });
      pickupDate = null;
    }
  }

  if (draft.returnDateISO) {
    returnDate = new Date(draft.returnDateISO);
    if (isNaN(returnDate.getTime())) {
      errors.push({ field: "returnDateISO", message: "Invalid return date." });
      returnDate = null;
    }
  }

  if (pickupDate && returnDate && returnDate <= pickupDate) {
    errors.push({
      field: "returnDateISO",
      message: "Return date must be after pickup date.",
    });
  }

  // Driver age check
  if (draft.driverAge != null) {
    const category = context.categories.find((c) => c.id === draft.categoryId);
    const minAge = category?.minDriverAge ?? 23;
    if (draft.driverAge < minAge) {
      errors.push({
        field: "driverAge",
        message: `Driver must be at least ${minAge} years old for this vehicle.`,
      });
    }
    if (draft.driverAge > 80) {
      errors.push({
        field: "driverAge",
        message: "Driver age cannot exceed 80.",
      });
    }
  }

  // Customer lead time (customer only)
  if (!isAdminMode && pickupDate) {
    const londonNow = new Date(
      new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })
    );
    const londonHour = londonNow.getHours();
    const minLeadDays = londonHour < 16 ? 1 : 2;
    const minPickup = new Date(londonNow);
    minPickup.setDate(minPickup.getDate() + minLeadDays);
    minPickup.setHours(0, 0, 0, 0);
    const pickupDay = new Date(pickupDate);
    pickupDay.setHours(0, 0, 0, 0);
    if (pickupDay < minPickup) {
      errors.push({
        field: "pickupDateISO",
        message: `Pickup must be at least ${minLeadDays === 1 ? "tomorrow" : "the day after tomorrow"} (London time).`,
      });
    }
  }

  // Same-day 6-hour minimum (customer only)
  if (!isAdminMode && pickupDate && returnDate) {
    const sameDay = pickupDate.toDateString() === returnDate.toDateString();
    if (sameDay) {
      const durationHours =
        (returnDate.getTime() - pickupDate.getTime()) / 3_600_000;
      if (durationHours < 6) {
        errors.push({
          field: "returnDateISO",
          message: `Same-day rentals must be at least 6 hours (selected: ${durationHours.toFixed(1)}h).`,
        });
      }
    }
  }

  // Confirmation
  if (!draft.confirmed) {
    errors.push({
      field: "confirmed",
      message: "Customer must explicitly confirm before reservation can be created.",
    });
  }

  // Customer info (for non-admin)
  if (!isAdminMode) {
    if (!draft.customerName) {
      errors.push({ field: "customerName", message: "Customer name is required." });
    }
    if (!draft.customerPhone) {
      errors.push({ field: "customerPhone", message: "Customer phone is required." });
    } else {
      const digits = draft.customerPhone.replace(/\D/g, "");
      if (digits.length !== 10 || !digits.startsWith("0")) {
        errors.push({
          field: "customerPhone",
          message: "Phone must be a 10-digit UK number starting with 0.",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build the POST /api/reservations payload from a confirmed draft.
 * Note: `messege` field spelling is intentionally preserved from the backend model.
 */
export function buildReservationPayload(
  draft: BookingDraft,
  userId: string,
  customerName: string,
  customerLastName: string,
  customerEmail: string,
  isAdminMode = false
): Record<string, unknown> {
  return {
    userData: {
      userId,
      name: customerName,
      lastName: customerLastName,
      email: customerEmail,
      phoneNumber: draft.customerPhone
        ? `+44${draft.customerPhone.replace(/^0/, "")}`
        : undefined,
    },
    reservationData: {
      office: draft.officeId,
      category: draft.categoryId,
      startDate: draft.pickupDateISO,
      endDate: draft.returnDateISO,
      startDateDisplay: draft.pickupDateText,
      endDateDisplay: draft.returnDateText,
      pickupTime: draft.pickupDateISO
        ? new Date(draft.pickupDateISO).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : undefined,
      returnTime: draft.returnDateISO
        ? new Date(draft.returnDateISO).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : undefined,
      totalPrice: draft.pricePreview?.totalPrice,
      driverAge: draft.driverAge,
      messege: "", // intentional misspelling preserved from backend model
      status: "pending",
      addOns: (draft.addOns ?? []).map((a) => ({
        addOn: a.addOnId,
        quantity: a.quantity,
        selectedTierIndex: a.selectedTierIndex,
      })),
      discountCode: undefined,
      selectedGear: draft.selectedGear ?? "manual",
      pickupExtensionPrice: draft.pricePreview?.pickupExtensionPrice ?? 0,
      returnExtensionPrice: draft.pricePreview?.returnExtensionPrice ?? 0,
      reservationType: isAdminMode ? "Office" : "Website",
    },
  };
}
