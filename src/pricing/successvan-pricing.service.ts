import type { CategoryContext, BusinessContext } from "../context/context-provider.interface.js";
import type { PricePreview, BookingDraftAddOn } from "../state/booking-draft.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Pricing Service
// Matches the logic in hooks/usePriceCalculation.ts (frontend reference).
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingInput {
  category: CategoryContext;
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
        const unitPrice = tier.isPerDay ? tier.price * days : tier.price;
        total += unitPrice * selectedAddOn.quantity;
      }
    }
  }

  return total;
}

/** Main pricing calculation. Returns null if dates are invalid. */
export function calculatePrice(input: PricingInput): PricePreview | null {
  const {
    category,
    pickupDateISO,
    returnDateISO,
    selectedGear,
    addOns = [],
    pickupExtensionPrice = 0,
    returnExtensionPrice = 0,
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

  const totalPrice =
    fullDays * pricePerDay +
    fullDays * gearExtraCost +
    extraHours * extraHourRate +
    pickupExtensionPrice +
    returnExtensionPrice +
    addOnsPrice;

  const roundedTotal = Math.round(totalPrice * 100) / 100;

  const parts: string[] = [
    `${fullDays} day${fullDays !== 1 ? "s" : ""} × £${pricePerDay.toFixed(2)}/day`,
  ];
  if (gearExtraCost > 0)
    parts.push(`automatic gear: £${(fullDays * gearExtraCost).toFixed(2)}`);
  if (extraHours > 0)
    parts.push(`${extraHours} extra hour${extraHours !== 1 ? "s" : ""} × £${extraHourRate.toFixed(2)}`);
  if (pickupExtensionPrice > 0)
    parts.push(`pickup extension: £${pickupExtensionPrice.toFixed(2)}`);
  if (returnExtensionPrice > 0)
    parts.push(`return extension: £${returnExtensionPrice.toFixed(2)}`);
  if (addOnsPrice > 0) parts.push(`add-ons: £${addOnsPrice.toFixed(2)}`);

  return {
    totalPrice: roundedTotal,
    currency: "GBP",
    days: fullDays,
    extraHours,
    pricePerDay: Math.round(pricePerDay * 100) / 100,
    gearExtraCost: Math.round(gearExtraCost * fullDays * 100) / 100,
    pickupExtensionPrice,
    returnExtensionPrice,
    addOnsPrice: Math.round(addOnsPrice * 100) / 100,
    explanation: parts.join(" + "),
  };
}
