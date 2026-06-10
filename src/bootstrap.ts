/**
 * Bootstrap — registers all tools, rules, and guardrails.
 * Called once at server startup before any requests are handled.
 */

import { registerTool } from "./tools/tool-registry.js";
import { registerRules } from "./rules/rule-engine.js";
import { registerGuardrails } from "./guardrails/guardrail-engine.js";

import { getOfficesTool } from "./tools/successvan/get-offices.tool.js";
import { getCategoriesTool } from "./tools/successvan/get-categories.tool.js";
import { resolveOfficeTool } from "./tools/successvan/resolve-office.tool.js";
import { resolveCategoryTool } from "./tools/successvan/resolve-category.tool.js";
import { calculatePriceTool } from "./tools/successvan/calculate-price.tool.js";
import { updateBookingDraftTool } from "./tools/successvan/create-booking-draft.tool.js";

import { successVanConversationRules } from "./rules/successvan.rules.js";
import { successVanReservationRules } from "./rules/successvan-reservation.rules.js";

import { successVanGuardrails } from "./guardrails/successvan.guardrails.js";

export function bootstrap(): void {
  // Tools
  registerTool(getOfficesTool);
  registerTool(getCategoriesTool);
  registerTool(resolveOfficeTool);
  registerTool(resolveCategoryTool);
  registerTool(calculatePriceTool);
  registerTool(updateBookingDraftTool);

  // Rules
  registerRules(successVanConversationRules as any[]);
  registerRules(successVanReservationRules as any[]);

  // Guardrails
  registerGuardrails(successVanGuardrails as any[]);

  console.log("[bootstrap] Tools, rules, and guardrails registered.");
}
