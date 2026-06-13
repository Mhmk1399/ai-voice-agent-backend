import { ReservationModel } from "../db/models/read-models.js";
import type { OfficeContext } from "../context/context-provider.interface.js";
import { getTimeSlotsForDate, type TimeSlot } from "./successvan-time-slot.service.js";
import { formatLondonDate, formatLondonTime } from "../utils/london-time.js";

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
  suggestedTime?: string;
}

type ReservationSlotSource = {
  _id?: { toString: () => string } | string;
  startDate?: Date | string;
  endDate?: Date | string;
  startDateDisplay?: string;
  endDateDisplay?: string;
  pickupTime?: string;
  returnTime?: string;
};

function toDayRange(dateText: string): { start: Date; end: Date } {
  const date = new Date(dateText);
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export async function loadReservedSlots(
  officeId: string,
  dateText: string,
  type: "start" | "end"
): Promise<Array<{
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
}>> {
  const date = formatLondonDate(new Date(dateText));
  const { start, end } = toDayRange(dateText);
  const query: Record<string, unknown> = { office: officeId };

  query.$or =
    type === "start"
      ? [{ startDate: { $gte: start, $lte: end } }, { startDateDisplay: date }]
      : [{ endDate: { $gte: start, $lte: end } }, { endDateDisplay: date }];

  let reservations = await ReservationModel.find(query).lean<
    ReservationSlotSource[]
  >();
  if (reservations.length === 0) {
    reservations = await ReservationModel.find({ office: officeId }).lean<
      ReservationSlotSource[]
    >();
  }

  return reservations.map((r) => {
    const resStart = new Date(r.startDate ?? "");
    const resEnd = new Date(r.endDate ?? "");
    return {
      startDate:
        r.startDateDisplay ??
        (isNaN(resStart.getTime()) ? "" : formatLondonDate(resStart)),
      endDate:
        r.endDateDisplay ??
        (isNaN(resEnd.getTime()) ? "" : formatLondonDate(resEnd)),
      startTime:
        r.pickupTime ??
        (isNaN(resStart.getTime()) ? "" : formatLondonTime(resStart)),
      endTime:
        r.returnTime ??
        (isNaN(resEnd.getTime()) ? "" : formatLondonTime(resEnd)),
    };
  });
}

export async function checkRequestedReservationSlots(params: {
  officeId?: string;
  pickupDateISO?: string;
  returnDateISO?: string;
}): Promise<AvailabilityResult> {
  const { officeId, pickupDateISO, returnDateISO } = params;
  if (!officeId || !pickupDateISO || !returnDateISO) {
    return { available: true };
  }

  const pickup = new Date(pickupDateISO);
  const ret = new Date(returnDateISO);
  if (isNaN(pickup.getTime()) || isNaN(ret.getTime())) {
    return { available: true };
  }

  const pickupDate = formatLondonDate(pickup);
  const returnDate = formatLondonDate(ret);
  const pickupTime = formatLondonTime(pickup);
  const returnTime = formatLondonTime(ret);

  const [pickupSlots, returnSlots] = await Promise.all([
    loadReservedSlots(officeId, pickupDateISO, "start"),
    loadReservedSlots(officeId, returnDateISO, "end"),
  ]);

  const pickupTaken = pickupSlots.some(
    (r) => r.startDate === pickupDate && r.startTime === pickupTime
  );
  if (pickupTaken) {
    return {
      available: false,
      reason: `The pickup slot ${pickupDate} at ${pickupTime} is already reserved. Please choose another pickup time.`,
    };
  }

  const returnTaken = returnSlots.some(
    (r) => r.endDate === returnDate && r.endTime === returnTime
  );
  if (returnTaken) {
    return {
      available: false,
      reason: `The return slot ${returnDate} at ${returnTime} is already reserved. Please choose another return time.`,
    };
  }

  return { available: true };
}

export async function checkSingleReservationSlot(params: {
  officeId?: string;
  office?: OfficeContext;
  dateISO?: string;
  kind: "pickup" | "return";
}): Promise<AvailabilityResult> {
  const { officeId, office, dateISO, kind } = params;
  if (!officeId || !dateISO) return { available: true };

  const date = new Date(dateISO);
  if (isNaN(date.getTime())) return { available: true };

  const dateText = formatLondonDate(date);
  const timeText = formatLondonTime(date);
  const slots = await loadReservedSlots(
    officeId,
    dateISO,
    kind === "pickup" ? "start" : "end"
  );

  const taken = slots.some((slot) =>
    kind === "pickup"
      ? slot.startDate === dateText && slot.startTime === timeText
      : slot.endDate === dateText && slot.endTime === timeText
  );

  if (!taken) return { available: true };

  const available = office
    ? await getAvailableTimeSlots({ officeId, office, dateISO, kind })
    : null;
  const suggestion = available
    ? findNearestAvailableTime(timeText, available.slots.map((slot) => slot.time))
    : undefined;

  return {
    available: false,
    suggestedTime: suggestion,
    reason: `The ${kind} slot ${dateText} at ${timeText} is already reserved. ${
      suggestion
        ? `The nearest available ${kind} time is ${suggestion}.`
        : `Please choose another ${kind} time.`
    }`,
  };
}

export async function getAvailableTimeSlots(params: {
  officeId: string;
  office: OfficeContext;
  dateISO: string;
  kind: "pickup" | "return";
}): Promise<{ date: string; slots: TimeSlot[]; reservedTimes: string[] }> {
  const date = new Date(params.dateISO);
  if (isNaN(date.getTime())) {
    return { date: "", slots: [], reservedTimes: [] };
  }

  const daySlots = getTimeSlotsForDate(date, params.office);
  const slots =
    params.kind === "pickup" ? daySlots.pickupSlots : daySlots.returnSlots;
  const reserved = await loadReservedSlots(
    params.officeId,
    params.dateISO,
    params.kind === "pickup" ? "start" : "end"
  );
  const dateText = formatLondonDate(date);
  const reservedTimes = reserved
    .map((slot) =>
      params.kind === "pickup" && slot.startDate === dateText
        ? slot.startTime
        : params.kind === "return" && slot.endDate === dateText
          ? slot.endTime
          : null
    )
    .filter((time): time is string => Boolean(time));
  const reservedSet = new Set(reservedTimes);

  return {
    date: dateText,
    slots: slots.filter((slot) => !reservedSet.has(slot.time)),
    reservedTimes,
  };
}

function findNearestAvailableTime(target: string, times: string[]): string | undefined {
  const targetMinutes = timeToMinutes(target);
  return times
    .map((time) => ({ time, distance: Math.abs(timeToMinutes(time) - targetMinutes) }))
    .sort((a, b) => a.distance - b.distance || a.time.localeCompare(b.time))[0]?.time;
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}
