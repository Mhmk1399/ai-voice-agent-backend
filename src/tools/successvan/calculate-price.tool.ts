import { contextProvider } from "../../context/successvan-context.provider.js";
import { calculatePrice } from "../../pricing/successvan-pricing.service.js";
import type { Tool, ToolOutput } from "../tool.types.js";
import type { PricePreview } from "../../state/booking-draft.types.js";
import type { BookingDraftAddOn } from "../../state/booking-draft.types.js";

interface CalculatePriceInput {
  categoryId: string;
  pickupDateISO: string;
  returnDateISO: string;
  selectedGear?: "manual" | "automatic";
  addOns?: BookingDraftAddOn[];
}

export const calculatePriceTool: Tool<CalculatePriceInput, PricePreview | null> = {
  name: "calculatePricePreview",
  description:
    "Calculate a price preview for the booking draft. Returns null if dates are invalid.",

  async execute(input: CalculatePriceInput): Promise<ToolOutput & { data?: PricePreview | null }> {
    const ctx = await contextProvider.load();
    const category = ctx.categories.find((c) => c.id === input.categoryId);

    if (!category) {
      return { success: false, error: `Category ${input.categoryId} not found` };
    }

    const preview = calculatePrice({
      category,
      pickupDateISO: input.pickupDateISO,
      returnDateISO: input.returnDateISO,
      selectedGear: input.selectedGear,
      addOns: input.addOns ?? [],
      context: ctx,
    });

    return { success: true, data: preview };
  },
};
