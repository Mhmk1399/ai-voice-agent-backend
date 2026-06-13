import type { OfficeContext, SpecialDay, WorkingDay } from "../context/context-provider.interface.js";
import { getLondonDateParts, getLondonWeekday } from "../utils/london-time.js";

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

export interface TimePolicyResult {
  available: boolean;
  isExtension: boolean;
  extensionPrice: number;
  reason: string;
  normalWindow?: { startTime: string; endTime: string };
  availableWindow?: { startTime: string; endTime: string };
  specialDayReason?: string;
}

/** Check if a date matches a special day (by month and day only). */
function matchesSpecialDay(date: Date, day: SpecialDay): boolean {
  const parts = getLondonDateParts(date);
  return day.month === parts.month && day.day === parts.day;
}

/** Parse HH:mm string to minutes from midnight. */
function parseTime(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isConfiguredExtension(ext: WorkingDay["pickupExtension"]): boolean {
  if (!ext) return false;
  if (ext.enabled === false) return false;
  return Boolean(
    ext.hoursBefore ||
      ext.hoursAfter ||
      ext.startTime ||
      ext.endTime ||
      ext.flatPrice
  );
}

function getWorkingExtensionWindow(
  baseStart: number,
  baseEnd: number,
  ext: WorkingDay["pickupExtension"]
): { start: number; end: number; price: number } | null {
  if (!isConfiguredExtension(ext)) return null;

  if (ext?.startTime || ext?.endTime) {
    return {
      start: ext.startTime ? parseTime(ext.startTime) : 0,
      end: ext.endTime ? parseTime(ext.endTime) : 23 * 60 + 59,
      price: ext.flatPrice ?? 0,
    };
  }

  return {
    start: Math.max(0, baseStart - (ext?.hoursBefore ?? 0) * 60),
    end: Math.min(23 * 60 + 59, baseEnd + (ext?.hoursAfter ?? 0) * 60),
    price: ext?.flatPrice ?? 0,
  };
}

function readSpecialWindow(
  specialDay: SpecialDay,
  kind: "pickup" | "return"
): { start: number; end: number; startTime: string; endTime: string } {
  const window =
    kind === "pickup"
      ? specialDay.pickupTime ?? specialDay.pickupExtension
      : specialDay.returnTime ??
        specialDay.returnExtension ??
        specialDay.pickupTime ??
        specialDay.pickupExtension;

  const startTime = window?.startTime ?? specialDay.startTime ?? "00:00";
  const endTime = window?.endTime ?? specialDay.endTime ?? "23:59";

  return {
    start: parseTime(startTime),
    end: parseTime(endTime),
    startTime,
    endTime,
  };
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

    const pickupWindow = readSpecialWindow(specialDay, "pickup");
    const returnWindow = readSpecialWindow(specialDay, "return");
    const specialPrice = specialDay.extraPrice ?? 0;

    return {
      isClosed: false,
      pickupSlots: generateSlots(pickupWindow.start, pickupWindow.end, false, 0),
      returnSlots: generateSlots(returnWindow.start, returnWindow.end, false, 0),
      pickupExtensionPrice: specialPrice,
      returnExtensionPrice: specialPrice,
    };
  }

  // Regular working day
  const dayName = getLondonWeekday(date);
  const workingDay = workingDays.find((wd) => wd.day.toLowerCase() === dayName);

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
  const pickupExtension = getWorkingExtensionWindow(
    baseStart,
    baseEnd,
    workingDay?.pickupExtension
  );
  if (pickupExtension) {
    const extStart = pickupExtension.start;
    const extEnd = pickupExtension.end;
    const extPrice = pickupExtension.price;

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
  const returnExtension = getWorkingExtensionWindow(
    baseStart,
    baseEnd,
    workingDay?.returnExtension
  );
  if (returnExtension) {
    const extStart = returnExtension.start;
    const extEnd = returnExtension.end;
    const extPrice = returnExtension.price;

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

export function checkOfficeTimePolicy(
  date: Date,
  time: string,
  office: OfficeContext,
  kind: "pickup" | "return"
): TimePolicyResult {
  const selectedMinutes = parseTime(time);
  const specialDay = (office.specialDays ?? []).find((sd) =>
    matchesSpecialDay(date, sd)
  );

  if (specialDay) {
    if (!specialDay.isOpen) {
      return {
        available: false,
        isExtension: false,
        extensionPrice: 0,
        reason: "The office is closed on that special day.",
        specialDayReason: specialDay.reason,
      };
    }

    const window = readSpecialWindow(specialDay, kind);
    const insideWindow =
      selectedMinutes >= window.start && selectedMinutes <= window.end;
    const price = specialDay.extraPrice ?? 0;

    return {
      available: insideWindow,
      isExtension: price > 0,
      extensionPrice: insideWindow ? price : 0,
      availableWindow: {
        startTime: window.startTime,
        endTime: window.endTime,
      },
      specialDayReason: specialDay.reason,
      reason: insideWindow
        ? price > 0
          ? `This is a special open day${specialDay.reason ? ` (${specialDay.reason})` : ""}, so the office applies its special-day charge.`
          : "This time is inside the special-day opening window."
        : `That time is outside the special-day ${kind} window of ${window.startTime}-${window.endTime}.`,
    };
  }

  const dayName = getLondonWeekday(date);
  const workingDay = (office.workingDays ?? []).find(
    (wd) => wd.day.toLowerCase() === dayName
  );

  if (!workingDay || !workingDay.isOpen) {
    return {
      available: false,
      isExtension: false,
      extensionPrice: 0,
      reason: "The office is closed on that day.",
    };
  }

  const baseStart = parseTime(workingDay.startTime ?? "00:00");
  const baseEnd = parseTime(workingDay.endTime ?? "23:59");
  const normalWindow = {
    startTime: workingDay.startTime ?? "00:00",
    endTime: workingDay.endTime ?? "23:59",
  };
  const inNormalHours =
    selectedMinutes >= baseStart && selectedMinutes <= baseEnd;

  if (inNormalHours) {
    return {
      available: true,
      isExtension: false,
      extensionPrice: 0,
      normalWindow,
      availableWindow: normalWindow,
      reason: `This ${kind} time is inside the normal office hours.`,
    };
  }

  const extension = getWorkingExtensionWindow(
    baseStart,
    baseEnd,
    kind === "pickup" ? workingDay.pickupExtension : workingDay.returnExtension
  );

  if (!extension) {
    return {
      available: false,
      isExtension: false,
      extensionPrice: 0,
      normalWindow,
      availableWindow: normalWindow,
      reason: `That ${kind} time is outside the normal office hours of ${normalWindow.startTime}-${normalWindow.endTime}.`,
    };
  }

  const insideExtension =
    selectedMinutes >= extension.start && selectedMinutes <= extension.end;
  const availableWindow = {
    startTime: formatTime(extension.start),
    endTime: formatTime(extension.end),
  };

  return {
    available: insideExtension,
    isExtension: insideExtension,
    extensionPrice: insideExtension ? extension.price : 0,
    normalWindow,
    availableWindow,
    reason: insideExtension
      ? `This ${kind} time is outside the normal office hours of ${normalWindow.startTime}-${normalWindow.endTime}, but it is inside the paid extension window.`
      : `That ${kind} time is outside the available ${kind} window of ${availableWindow.startTime}-${availableWindow.endTime}.`,
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
