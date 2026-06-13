import type { CategoryContext, BusinessContext } from "../context/context-provider.interface.js";
import type { PricePreview, BookingDraftAddOn } from "../state/booking-draft.types.js";
import { checkOfficeTimePolicy } from "../time/successvan-time-slot.service.js";
import { formatLondonTime, getLondonDateParts } from "../utils/london-time.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Pricing Service
// Matches the logic in hooks/usePriceCalculation.ts (frontend reference).
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingInput {
  category: CategoryContext;
  officeId?: string;
  pickupDateISO: string;
  returnDateISO: string;
  selectedGear?: "manual" | "automatic";
  addOns?: BookingDraftAddOn[];
  pickupExtensionPrice?: number;
  returnExtensionPrice?: number;
  context?: BusinessContext;
}

export interface BillableTime {
  fullDays: number;
  extraHours: number;
  billableHours: number;
}

/** Calculate billable time using SuccessVan rounding rules. */
export function calculateBillableTime(
  pickupISO: string,
  returnISO: string
): BillableTime | null {
  const start = new Date(pickupISO);
  const end = new Date(returnISO);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;

  const totalMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (totalMinutes <= 0) return null;

  const wholeHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;

  // Round up if remaining minutes > 15
  const billableHours = remainingMinutes > 15 ? wholeHours + 1 : wholeHours;

  if (billableHours <= 0) return null;

  // Less than 24 hours → charge 1 day, no extra hours
  if (billableHours < 24) {
    return { fullDays: 1, extraHours: 0, billableHours };
  }

  let fullDays = Math.floor(billableHours / 24);
  let extraHours = billableHours % 24;

  // Extra hours > 6 → round up to full day
  if (extraHours > 6) {
    fullDays += 1;
    extraHours = 0;
  }

  return { fullDays, extraHours, billableHours };
}

/** Select the best pricing tier for the given number of days. */
function selectTier(
  tiers: CategoryContext["pricingTiers"],
  days: number
): { pricePerDay: number } | null {
  if (!tiers || tiers.length === 0) return null;

  const matching = tiers.filter(
    (t) => days >= t.minDays && days <= t.maxDays
  );

  if (matching.length > 0) {
    return matching[0];
  }

  // Fallback: last tier
  return tiers[tiers.length - 1];
}

/** Calculate add-ons total price. */
function calculateAddOnsPrice(
  addOns: BookingDraftAddOn[],
  days: number,
  context?: BusinessContext
): number {
  if (!context || addOns.length === 0) return 0;

  let total = 0;
  for (const selectedAddOn of addOns) {
    const addOnDef = context.addOns.find((a) => a.id === selectedAddOn.addOnId);
    if (!addOnDef) continue;

    if (addOnDef.pricingType === "flat" && addOnDef.flatPrice) {
      const unitPrice = addOnDef.flatPrice.isPerDay
        ? addOnDef.flatPrice.amount * days
        : addOnDef.flatPrice.amount;
      total += unitPrice * selectedAddOn.quantity;
    } else if (addOnDef.pricingType === "tiered" && addOnDef.tieredPrice) {
      const tierIndex = selectedAddOn.selectedTierIndex ?? 0;
      const tier = (addOnDef.tieredPrice as any).tiers?.[tierIndex];
      if (tier) {
        const isPerDay = tier.isPerDay ?? (addOnDef.tieredPrice as any).isPerDay ?? false;
        const unitPrice = isPerDay ? tier.price * days : tier.price;
        total += unitPrice * selectedAddOn.quantity;
      }
    }
  }

  return total;
}

function calculateSpecialDaysPrice(
  officeId: string | undefined,
  pickupDateISO: string,
  returnDateISO: string,
  context?: BusinessContext
): number {
  if (!officeId || !context) return 0;
  const office = context.offices.find((o) => o.id === officeId);
  const specialDays = office?.specialDays ?? [];
  if (specialDays.length === 0) return 0;

  const start = new Date(pickupDateISO);
  const end = new Date(returnDateISO);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;

  let total = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setHours(0, 0, 0, 0);

  while (current <= endDay) {
    const { month, day } = getLondonDateParts(current);
    const specialDay = specialDays.find((sd) => sd.month === month && sd.day === day);
    if (specialDay?.isOpen && specialDay.extraPrice && specialDay.extraPrice > 0) {
      total += specialDay.extraPrice;
    }
    current.setDate(current.getDate() + 1);
  }

  return total;
}

function calculateOfficeExtensionPrices(
  officeId: string | undefined,
  pickupDateISO: string,
  returnDateISO: string,
  context?: BusinessContext
): { pickupExtensionPrice: number; returnExtensionPrice: number } {
  if (!officeId || !context) {
    return { pickupExtensionPrice: 0, returnExtensionPrice: 0 };
  }

  const office = context.offices.find((o) => o.id === officeId);
  if (!office) {
    return { pickupExtensionPrice: 0, returnExtensionPrice: 0 };
  }

  const pickup = new Date(pickupDateISO);
  const ret = new Date(returnDateISO);
  if (isNaN(pickup.getTime()) || isNaN(ret.getTime())) {
    return { pickupExtensionPrice: 0, returnExtensionPrice: 0 };
  }

  const pickupDate = new Date(pickup);
  pickupDate.setHours(0, 0, 0, 0);
  const returnDate = new Date(ret);
  returnDate.setHours(0, 0, 0, 0);

  const pickupSpecial = findSpecialDay(office.specialDays ?? [], pickupDate);
  const returnSpecial = findSpecialDay(office.specialDays ?? [], returnDate);
  const sameSpecialDay =
    Boolean(
      pickupSpecial?.isOpen &&
      returnSpecial?.isOpen &&
      pickupSpecial.month === returnSpecial.month &&
      pickupSpecial.day === returnSpecial.day &&
      pickupDate.getTime() === returnDate.getTime()
    );

  let pickupExtensionPrice = 0;
  let returnExtensionPrice = 0;

  if (pickupSpecial?.isOpen) {
    pickupExtensionPrice = pickupSpecial.extraPrice ?? 0;
  } else {
    const pickupPolicy = checkOfficeTimePolicy(pickup, toTime(pickup), office, "pickup");
    pickupExtensionPrice = pickupPolicy.extensionPrice;
  }

  if (returnSpecial?.isOpen) {
    returnExtensionPrice = sameSpecialDay ? 0 : returnSpecial.extraPrice ?? 0;
  } else {
    const returnPolicy = checkOfficeTimePolicy(ret, toTime(ret), office, "return");
    returnExtensionPrice = returnPolicy.extensionPrice;
  }

  return { pickupExtensionPrice, returnExtensionPrice };
}

function toTime(date: Date): string {
  return formatLondonTime(date);
}

function findSpecialDay(
  specialDays: NonNullable<BusinessContext["offices"][number]["specialDays"]>,
  date: Date
) {
  const { month, day } = getLondonDateParts(date);
  return specialDays.find((sd) => sd.month === month && sd.day === day);
}

/** Main pricing calculation. Returns null if dates are invalid. */
export function calculatePrice(input: PricingInput): PricePreview | null {
  const {
    category,
    officeId,
    pickupDateISO,
    returnDateISO,
    selectedGear,
    addOns = [],
    pickupExtensionPrice,
    returnExtensionPrice,
    context,
  } = input;

  const billable = calculateBillableTime(pickupDateISO, returnDateISO);
  if (!billable) return null;

  const { fullDays, extraHours } = billable;

  const tier = selectTier(category.pricingTiers, fullDays);
  if (!tier) return null;

  // Apply sell offer (discount percentage on price per day)
  const sellOffer = category.selloffer ?? 0;
  const pricePerDay = tier.pricePerDay * (1 - sellOffer / 100);

  // Gear extra cost
  const gear = category.gear;
  const supportsAuto = gear?.availableTypes?.includes("automatic");
  const supportsManual = gear?.availableTypes?.includes("manual");
  const gearExtraCost =
    selectedGear === "automatic" && supportsAuto && supportsManual
      ? (gear?.automaticExtraCost ?? 0)
      : 0;

  // Extra hour rate
  const extraHourRate = category.extraHourRate ?? 0;

  // Add-ons
  const addOnsPrice = calculateAddOnsPrice(addOns, fullDays, context);
  const extensionPrices = calculateOfficeExtensionPrices(
    officeId,
    pickupDateISO,
    returnDateISO,
    context
  );
  const finalPickupExtensionPrice =
    pickupExtensionPrice ?? extensionPrices.pickupExtensionPrice;
  const finalReturnExtensionPrice =
    returnExtensionPrice ?? extensionPrices.returnExtensionPrice;
  const specialDaysPrice = calculateSpecialDaysPrice(
    officeId,
    pickupDateISO,
    returnDateISO,
    context
  );

  const totalPrice =
    fullDays * pricePerDay +
    fullDays * gearExtraCost +
    extraHours * extraHourRate +
    finalPickupExtensionPrice +
    finalReturnExtensionPrice +
    addOnsPrice +
    specialDaysPrice;

  const roundedTotal = Math.round(totalPrice * 100) / 100;

  const parts: string[] = [
    `${fullDays} day${fullDays !== 1 ? "s" : ""} × £${pricePerDay.toFixed(2)}/day`,
  ];
  if (gearExtraCost > 0)
    parts.push(`automatic gear: £${(fullDays * gearExtraCost).toFixed(2)}`);
  if (extraHours > 0)
    parts.push(`${extraHours} extra hour${extraHours !== 1 ? "s" : ""} × £${extraHourRate.toFixed(2)}`);
  if (finalPickupExtensionPrice > 0)
    parts.push(`pickup extension: £${finalPickupExtensionPrice.toFixed(2)}`);
  if (finalReturnExtensionPrice > 0)
    parts.push(`return extension: £${finalReturnExtensionPrice.toFixed(2)}`);
  if (addOnsPrice > 0) parts.push(`add-ons: £${addOnsPrice.toFixed(2)}`);
  if (specialDaysPrice > 0) parts.push(`special days: £${specialDaysPrice.toFixed(2)}`);

  return {
    totalPrice: roundedTotal,
    currency: "GBP",
    days: fullDays,
    extraHours,
    pricePerDay: Math.round(pricePerDay * 100) / 100,
    gearExtraCost: Math.round(gearExtraCost * fullDays * 100) / 100,
    pickupExtensionPrice: Math.round(finalPickupExtensionPrice * 100) / 100,
    returnExtensionPrice: Math.round(finalReturnExtensionPrice * 100) / 100,
    addOnsPrice: Math.round(addOnsPrice * 100) / 100,
    specialDaysPrice: Math.round(specialDaysPrice * 100) / 100,
    explanation: parts.join(" + "),
  };
}
