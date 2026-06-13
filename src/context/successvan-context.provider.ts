import { env } from "../config/env.js";
import { AddOnModel, CategoryModel, OfficeModel } from "../db/models/read-models.js";
import type {
  BusinessContext,
  CategoryContext,
  ContextProvider,
  OfficeContext,
  AddOnContext,
} from "./context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessVan Context Provider
// Loads offices, categories, and add-ons from MongoDB with TTL cache.
// ─────────────────────────────────────────────────────────────────────────────

let cached: BusinessContext | null = null;
let cacheExpiresAt = 0;

export class SuccessVanContextProvider implements ContextProvider {
  async load(): Promise<BusinessContext> {
    if (cached && Date.now() < cacheExpiresAt) {
      return cached;
    }

    const [rawOffices, rawCategories, rawAddOns] = await Promise.all([
      OfficeModel.find({ status: "active" })
        .select("name address phone status workingTime specialDays")
        .lean<Record<string, unknown>[]>(),
      CategoryModel.find({ status: "active" })
        .select(
          "name description purpose status office type showPrice selloffer extrahoursRate extraHourRate pricingTiers gear seats fuel"
        )
        .lean<Record<string, unknown>[]>(),
      AddOnModel.find({ status: "active" })
        .select("name description pricingType flatPrice tieredPrice status")
        .lean<Record<string, unknown>[]>(),
    ]);

    const offices: OfficeContext[] = rawOffices.map((o) => ({
      id: String((o as any)._id),
      name: String(o.name ?? ""),
      address: o.address ? String(o.address) : undefined,
      phone: o.phone ? String(o.phone) : undefined,
      status: String(o.status ?? "active"),
      workingDays: (o as any).workingTime ?? [],
      specialDays: (o as any).specialDays ?? [],
    }));

    const categories: CategoryContext[] = rawCategories.map((c) => {
      const typeName = String((c as any).type?.name ?? "");
      const isMinibus =
        typeName.toLowerCase().includes("minibus") ||
        typeName.toLowerCase().includes("mini bus");
      return {
        id: String((c as any)._id),
        name: String(c.name ?? ""),
        description: c.description ? String(c.description) : undefined,
        purpose: c.purpose ? String(c.purpose) : undefined,
        status: String(c.status ?? "active"),
        officeId: (c as any).office ? String((c as any).office) : undefined,
        typeId: (c as any).type?._id
          ? String((c as any).type._id)
          : (c as any).type
          ? String((c as any).type)
          : undefined,
        typeName,
        showPrice: typeof c.showPrice === "number" ? c.showPrice : undefined,
        selloffer: typeof c.selloffer === "number" ? c.selloffer : undefined,
        extraHourRate:
          typeof (c as any).extrahoursRate === "number"
            ? (c as any).extrahoursRate
            : typeof (c as any).extraHourRate === "number"
            ? (c as any).extraHourRate
            : undefined,
        pricingTiers: Array.isArray(c.pricingTiers)
          ? (c.pricingTiers as any[]).map((t) => ({
              minDays: t.minDays ?? 0,
              maxDays: t.maxDays ?? 999,
              pricePerDay: t.pricePerDay ?? 0,
            }))
          : [],
        gear: c.gear as any,
        seats: typeof c.seats === "number" ? c.seats : undefined,
        fuel: c.fuel ? String(c.fuel) : undefined,
        minDriverAge: isMinibus ? 25 : 23,
      };
    });

    const addOns: AddOnContext[] = rawAddOns.map((a) => ({
      id: String((a as any)._id),
      name: String(a.name ?? ""),
      description: a.description ? String(a.description) : undefined,
      pricingType: a.pricingType as "flat" | "tiered" | undefined,
      flatPrice: (a as any).flatPrice
        ? {
            amount: Number((a as any).flatPrice.amount ?? 0),
            isPerDay: Boolean((a as any).flatPrice.isPerDay),
          }
        : undefined,
      tieredPrice: (a as any).tieredPrice,
      status: String(a.status ?? "active"),
    }));

    cached = {
      offices,
      categories,
      addOns,
      loadedAt: new Date().toISOString(),
    };
    cacheExpiresAt = Date.now() + env.CONTEXT_CACHE_TTL_MS;

    return cached;
  }

  invalidate(): void {
    cached = null;
    cacheExpiresAt = 0;
  }
}

/** Singleton. */
export const contextProvider: ContextProvider = new SuccessVanContextProvider();

/** Force reload on next request. */
export function invalidateContext(): void {
  contextProvider.invalidate();
}
