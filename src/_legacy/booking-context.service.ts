import { AddOnModel, CategoryModel, OfficeModel } from "../db/models/read-models.js";

// ──────────────────────────────────────────────────────────────────────────────
// Context cache
// ──────────────────────────────────────────────────────────────────────────────

/**
 * TTL cache for booking context.
 *
 * Offices, categories, and add-ons almost never change during a call session.
 * Without caching, every turn would hit MongoDB with three queries.
 * With a 60-second TTL the first turn in each minute pays the DB cost;
 * all subsequent turns in the same minute are free.
 *
 * To invalidate immediately (e.g. after an admin updates a category):
 *   import { invalidateBookingContext } from "./booking-context.service.js";
 *   invalidateBookingContext();
 */
const CACHE_TTL_MS = 60_000; // 60 seconds

let cachedContext: BookingContext | null = null;
let cacheExpiresAt = 0;

/** Force the next getBookingContext() call to re-query MongoDB. */
export function invalidateBookingContext(): void {
  cachedContext = null;
  cacheExpiresAt = 0;
}

export type AgentOfficeContext = {
  id: string;
  name: string;
  address?: string;
  phone?: string;
  categories: string[];
  workingTime?: unknown[];
};

export type AgentCategoryContext = {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  expert?: string;
  showPrice?: number;
  selloffer?: number;
  requiredLicense?: string;
  pricingTiers?: {
    minDays: number;
    maxDays: number;
    pricePerDay: number;
  }[];
  gear?: {
    availableTypes?: unknown[];
    automaticExtraCost?: number;
  };
  seats?: number;
  doors?: number;
  fuel?: string;
  properties?: unknown[];
  rules?: unknown[];
};

export type AgentAddOnContext = {
  id: string;
  name: string;
  description?: string;
  pricingType?: "flat" | "tiered";
  flatPrice?: {
    amount?: number;
    isPerDay?: boolean;
  };
  tieredPrice?: unknown;
};

export type BookingContext = {
  offices: AgentOfficeContext[];
  categories: AgentCategoryContext[];
  addOns: AgentAddOnContext[];
};

/**
 * Load booking context from MongoDB with a 60-second in-memory TTL cache.
 *
 * The first call hits MongoDB. Subsequent calls within the TTL window return
 * the cached result immediately (< 1 ms vs. ~20–80 ms for a DB round-trip).
 *
 * Thread safety: Node.js is single-threaded so no mutex is needed.
 * Concurrent calls during a cache miss will all hit MongoDB. This is
 * acceptable for low traffic; add a promise coalescing pattern if needed.
 */
export async function getBookingContext(): Promise<BookingContext> {
  if (cachedContext && Date.now() < cacheExpiresAt) {
    return cachedContext;
  }

  const [offices, categories, addOns] = await Promise.all([
    OfficeModel.find({ status: "active" })
      .select("name address phone categories workingTime specialDays")
      .lean(),

    CategoryModel.find({ status: "active" })
      .select(
        "name description purpose expert showPrice selloffer requiredLicense pricingTiers gear seats doors fuel properties rules"
      )
      .lean(),

    AddOnModel.find({ status: "active" })
      .select("name description pricingType flatPrice tieredPrice")
      .lean(),
  ]);

  const result: BookingContext = {
    offices: offices.map((office: any) => ({
      id: office._id.toString(),
      name: office.name,
      address: office.address,
      phone: office.phone,
      categories: (office.categories || []).map((id: any) => id.toString()),
      workingTime: office.workingTime,
    })),

    categories: categories.map((category: any) => ({
      id: category._id.toString(),
      name: category.name,
      description: category.description,
      purpose: category.purpose,
      expert: category.expert,
      showPrice: category.showPrice,
      selloffer: category.selloffer,
      requiredLicense: category.requiredLicense,
      pricingTiers: category.pricingTiers,
      gear: category.gear,
      seats: category.seats,
      doors: category.doors,
      fuel: category.fuel,
      properties: category.properties,
      rules: category.rules,
    })),

    addOns: addOns.map((addOn: any) => ({
      id: addOn._id.toString(),
      name: addOn.name,
      description: addOn.description,
      pricingType: addOn.pricingType,
      flatPrice: addOn.flatPrice,
      tieredPrice: addOn.tieredPrice,
    })),
  };

  // Store in cache
  cachedContext = result;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;

  return result;
}