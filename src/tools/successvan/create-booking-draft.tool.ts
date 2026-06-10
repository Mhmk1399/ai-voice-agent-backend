import type { BookingDraft } from "../../state/booking-draft.types.js";
import type { Tool, ToolOutput } from "../tool.types.js";

interface UpdateBookingDraftInput {
  sessionId: string;
  updates: Partial<BookingDraft>;
}

/**
 * updateBookingDraft — applies partial updates to a draft.
 * The actual persistence is handled by the state manager; this tool
 * returns the merge result for tracing purposes.
 */
export const updateBookingDraftTool: Tool<UpdateBookingDraftInput, Partial<BookingDraft>> = {
  name: "updateBookingDraft",
  description: "Apply partial field updates to the in-progress booking draft.",

  async execute(input: UpdateBookingDraftInput): Promise<ToolOutput & { data?: Partial<BookingDraft> }> {
    // Validation: filter null/undefined values
    const clean: Partial<BookingDraft> = Object.fromEntries(
      Object.entries(input.updates).filter(([, v]) => v != null)
    ) as Partial<BookingDraft>;

    return { success: true, data: clean };
  },
};
