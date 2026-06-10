import type { OfficeContext, SpecialDay, WorkingDay } from "../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Time Slot Service
// Generates pickup and return time slots for a given date and office.
// Matches the rules in utils/timeSlots.ts and lib/specialDaySchedule.ts
// ─────────────────────────────────────────────────────────────────────────────

const SLOT_INTERVAL_MINUTES = 15;

export interface TimeSlot {
  time: string; // HH:mm
  isExtension: boolean;
  extensionPrice: number;
}

export interface DaySlotResult {
  isClosed: boolean;
  pickupSlots: TimeSlot[];
  returnSlots: TimeSlot[];
  pickupExtensionPrice: number;
  returnExtensionPrice: number;
}

/** Check if a date matches a special day (by month and day only). */
function matchesSpecialDay(date: Date, day: SpecialDay): boolean {
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const d = date.getDate();
  return day.month === month && day.day === d;
}

/** Parse HH:mm string to minutes from midnight. */
function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Format minutes from midnight to HH:mm. */
function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Generate time slots between startMinutes and endMinutes every 15 minutes. */
function generateSlots(
  startMinutes: number,
  endMinutes: number,
  isExtension: boolean,
  extensionPrice: number
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (let t = startMinutes; t <= endMinutes; t += SLOT_INTERVAL_MINUTES) {
    slots.push({ time: formatTime(t), isExtension, extensionPrice });
  }
  return slots;
}

export function getTimeSlotsForDate(
  date: Date,
  office: OfficeContext
): DaySlotResult {
  const specialDays = (office.specialDays ?? []) as SpecialDay[];
  const workingDays = (office.workingDays ?? []) as WorkingDay[];

  // Find matching special day
  const specialDay = specialDays.find((sd) => matchesSpecialDay(date, sd));

  if (specialDay) {
    if (!specialDay.isOpen) {
      return {
        isClosed: true,
        pickupSlots: [],
        returnSlots: [],
        pickupExtensionPrice: 0,
        returnExtensionPrice: 0,
      };
    }

    // Pickup window priority: pickupTime > pickupExtension > startTime/endTime > fallback
    let pickupStart = 0;
    let pickupEnd = 23 * 60 + 59;
    let pickupExtensionPrice = 0;

    if (specialDay.pickupTime) {
      const [ps, pe] = specialDay.pickupTime.split("-");
      if (ps) pickupStart = parseTime(ps);
      if (pe) pickupEnd = parseTime(pe);
      pickupExtensionPrice = specialDay.extraPrice ?? 0;
    } else if (specialDay.pickupExtension?.enabled) {
      if (specialDay.pickupExtension.startTime)
        pickupStart = parseTime(specialDay.pickupExtension.startTime);
      if (specialDay.pickupExtension.endTime)
        pickupEnd = parseTime(specialDay.pickupExtension.endTime);
      pickupExtensionPrice = specialDay.pickupExtension.flatPrice ?? 0;
    } else if (specialDay.startTime && specialDay.endTime) {
      pickupStart = parseTime(specialDay.startTime);
      pickupEnd = parseTime(specialDay.endTime);
    }

    // Return window priority
    let returnStart = 0;
    let returnEnd = 23 * 60 + 59;
    let returnExtensionPrice = 0;

    if (specialDay.returnTime) {
      const [rs, re] = specialDay.returnTime.split("-");
      if (rs) returnStart = parseTime(rs);
      if (re) returnEnd = parseTime(re);
      returnExtensionPrice = specialDay.extraPrice ?? 0;
    } else if (specialDay.returnExtension?.enabled) {
      if (specialDay.returnExtension.startTime)
        returnStart = parseTime(specialDay.returnExtension.startTime);
      if (specialDay.returnExtension.endTime)
        returnEnd = parseTime(specialDay.returnExtension.endTime);
      returnExtensionPrice = specialDay.returnExtension.flatPrice ?? 0;
    } else if (specialDay.pickupTime) {
      // Fall back to pickup time for return
      const [ps, pe] = specialDay.pickupTime.split("-");
      if (ps) returnStart = parseTime(ps);
      if (pe) returnEnd = parseTime(pe);
    } else if (specialDay.startTime && specialDay.endTime) {
      returnStart = parseTime(specialDay.startTime);
      returnEnd = parseTime(specialDay.endTime);
    }

    return {
      isClosed: false,
      pickupSlots: generateSlots(pickupStart, pickupEnd, false, 0),
      returnSlots: generateSlots(returnStart, returnEnd, false, 0),
      pickupExtensionPrice,
      returnExtensionPrice,
    };
  }

  // Regular working day
  const dayName = date.toLocaleDateString("en-GB", { weekday: "long" });
  const workingDay = workingDays.find(
    (wd) => wd.day.toLowerCase() === dayName.toLowerCase()
  );

  if (workingDay && !workingDay.isOpen) {
    return {
      isClosed: true,
      pickupSlots: [],
      returnSlots: [],
      pickupExtensionPrice: 0,
      returnExtensionPrice: 0,
    };
  }

  const baseStart = workingDay?.startTime ? parseTime(workingDay.startTime) : 0;
  const baseEnd = workingDay?.endTime
    ? parseTime(workingDay.endTime)
    : 23 * 60 + 59;

  let pickupSlots: TimeSlot[] = generateSlots(baseStart, baseEnd, false, 0);
  let returnSlots: TimeSlot[] = generateSlots(baseStart, baseEnd, false, 0);
  let pickupExtensionPrice = 0;
  let returnExtensionPrice = 0;

  // Add pickup extension slots
  if (workingDay?.pickupExtension?.enabled) {
    const ext = workingDay.pickupExtension;
    const extStart = ext.startTime ? parseTime(ext.startTime) : 0;
    const extEnd = ext.endTime ? parseTime(ext.endTime) : 23 * 60 + 59;
    const extPrice = ext.flatPrice ?? 0;

    // Extension before normal hours
    if (extStart < baseStart) {
      const earlySlots = generateSlots(extStart, baseStart - SLOT_INTERVAL_MINUTES, true, extPrice);
      pickupSlots = [...earlySlots, ...pickupSlots];
    }
    // Extension after normal hours
    if (extEnd > baseEnd) {
      const lateSlots = generateSlots(baseEnd + SLOT_INTERVAL_MINUTES, extEnd, true, extPrice);
      pickupSlots = [...pickupSlots, ...lateSlots];
    }
    pickupExtensionPrice = extPrice;
  }

  // Add return extension slots
  if (workingDay?.returnExtension?.enabled) {
    const ext = workingDay.returnExtension;
    const extStart = ext.startTime ? parseTime(ext.startTime) : 0;
    const extEnd = ext.endTime ? parseTime(ext.endTime) : 23 * 60 + 59;
    const extPrice = ext.flatPrice ?? 0;

    if (extStart < baseStart) {
      const earlySlots = generateSlots(extStart, baseStart - SLOT_INTERVAL_MINUTES, true, extPrice);
      returnSlots = [...earlySlots, ...returnSlots];
    }
    if (extEnd > baseEnd) {
      const lateSlots = generateSlots(baseEnd + SLOT_INTERVAL_MINUTES, extEnd, true, extPrice);
      returnSlots = [...returnSlots, ...lateSlots];
    }
    returnExtensionPrice = extPrice;
  }

  return {
    isClosed: false,
    pickupSlots,
    returnSlots,
    pickupExtensionPrice,
    returnExtensionPrice,
  };
}

/**
 * Check if a pickup date is valid for a customer (London-time lead time rules).
 */
export function isPickupDateValidForCustomer(
  pickupDate: Date,
  nowLondon?: Date
): { valid: boolean; message?: string } {
  const london = nowLondon ?? new Date(
    new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })
  );

  const hour = london.getHours();
  const minLeadDays = hour < 16 ? 1 : 2;

  const minPickup = new Date(london);
  minPickup.setDate(minPickup.getDate() + minLeadDays);
  minPickup.setHours(0, 0, 0, 0);

  const pickupDay = new Date(pickupDate);
  pickupDay.setHours(0, 0, 0, 0);

  if (pickupDay < minPickup) {
    return {
      valid: false,
      message: `Pickup must be at least ${minLeadDays} day(s) from now (London time).`,
    };
  }

  return { valid: true };
}
