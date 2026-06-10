import { z } from "zod";
import { openai } from "../ai/openai.client.js";
import { getBookingContext } from "../context/booking-context.service.js";
import {
  getMissingBookingFields,
  getQuestionForField,
  mergeBookingDraft,
} from "./booking-state.service.js";
import type {
  BookingAgentResult,
  BookingDraft,
} from "./types/booking.types.js";

const ExtractedBookingSchema = z.object({
  officeId: z.string().optional(),
  officeName: z.string().optional(),

  categoryId: z.string().optional(),
  categoryName: z.string().optional(),

  startDateText: z.string().optional(),
  endDateText: z.string().optional(),

  driverAge: z.number().optional(),

  selectedGear: z.enum(["manual", "automatic"]).optional(),

  customerPhone: z.string().optional(),
  customerName: z.string().optional(),
});

type ExtractedBookingData = z.infer<typeof ExtractedBookingSchema>;

export async function runBookingAgent(params: {
  transcript: string;
  currentDraft: BookingDraft;
}): Promise<BookingAgentResult> {
  const { transcript, currentDraft } = params;

  const context = await getBookingContext();

  const extraction = await extractBookingData({
    transcript,
    currentDraft,
    context,
  });

  const bookingDraft = mergeBookingDraft(currentDraft, extraction);

  const missingFields = getMissingBookingFields(bookingDraft);
  const isReadyForConfirmation = missingFields.length === 0;

  if (isReadyForConfirmation) {
    return {
      message: buildConfirmationMessage(bookingDraft),
      bookingDraft,
      missingFields,
      isReadyForConfirmation,
    };
  }

  const nextField = missingFields[0];

  return {
    message: getQuestionForField(nextField),
    bookingDraft,
    missingFields,
    isReadyForConfirmation,
  };
}

async function extractBookingData(params: {
  transcript: string;
  currentDraft: BookingDraft;
  context: Awaited<ReturnType<typeof getBookingContext>>;
}): Promise<ExtractedBookingData> {
  const { transcript, currentDraft, context } = params;

  const compactContext = {
    offices: context.offices.map((office) => ({
      id: office.id,
      name: office.name,
      address: office.address,
      availableCategoryIds: office.categories,
    })),
    categories: context.categories.map((category) => ({
      id: category.id,
      name: category.name,
      purpose: category.purpose,
      seats: category.seats,
      doors: category.doors,
      fuel: category.fuel,
      showPrice: category.showPrice,
      requiredLicense: category.requiredLicense,
      gear: category.gear,
      pricingTiers: category.pricingTiers,
    })),
    currentDraft,
  };

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_object",
    },
    messages: [
      {
        role: "system",
        content: `
You are a van rental booking extraction engine.

Your job:
Extract booking details from the user's speech and map them to the available office/category IDs.

Return ONLY valid JSON.

Allowed output fields:
{
  "officeId": string,
  "officeName": string,
  "categoryId": string,
  "categoryName": string,
  "startDateText": string,
  "endDateText": string,
  "driverAge": number,
  "selectedGear": "manual" | "automatic",
  "customerPhone": string,
  "customerName": string
}

Rules:
- Do not invent offices or categories.
- officeId must be one of the provided office IDs.
- categoryId must be one of the provided category IDs.
- If user says "Luton", match the closest real category from context.
- If user describes needs like "moving a sofa" or "5 boxes", choose a category only if clearly implied by the available category purpose/specs.
- If uncertain about category, omit categoryId and categoryName.
- Keep dates as natural text for now, like "tomorrow morning" or "Friday at 5pm".
- Do not overwrite existing currentDraft values unless the user clearly changes them.
- If the user gives age, extract driverAge.
- Return empty JSON if nothing useful is found.
        `.trim(),
      },
      {
        role: "user",
        content: JSON.stringify({
          transcript,
          context: compactContext,
        }),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;

  if (!content) return {};

  try {
    const parsed = JSON.parse(content);
    return ExtractedBookingSchema.parse(parsed);
  } catch {
    return {};
  }
}

function buildConfirmationMessage(draft: BookingDraft) {
  return [
    "Great. I have the booking details:",
    draft.officeName ? `Office: ${draft.officeName}` : undefined,
    draft.categoryName ? `Van: ${draft.categoryName}` : undefined,
    draft.startDateText ? `Pickup: ${draft.startDateText}` : undefined,
    draft.endDateText ? `Return: ${draft.endDateText}` : undefined,
    draft.driverAge ? `Driver age: ${draft.driverAge}` : undefined,
    draft.selectedGear ? `Gearbox: ${draft.selectedGear}` : undefined,
    "Should I continue with this booking?",
  ]
    .filter(Boolean)
    .join(" ");
}