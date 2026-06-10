import type { Guardrail, GuardrailContext, GuardrailResult } from "./guardrail.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail Engine
// ─────────────────────────────────────────────────────────────────────────────

const guardrailRegistry: Guardrail[] = [];

export function registerGuardrails(guardrails: Guardrail[]): void {
  guardrailRegistry.push(...guardrails);
}

export interface GuardrailRunResult {
  results: GuardrailResult[];
  finalResponse: string;
  wasRewritten: boolean;
  wasBlocked: boolean;
}

export function runGuardrails(
  response: string,
  ctx: Omit<GuardrailContext, "response">
): GuardrailRunResult {
  const results: GuardrailResult[] = [];
  let finalResponse = response;
  let wasRewritten = false;
  let wasBlocked = false;

  for (const guardrail of guardrailRegistry) {
    const result = guardrail.check({ ...ctx, response: finalResponse } as GuardrailContext);
    results.push(result);

    if (!result.passed) {
      if (result.blocked && result.rewrite) {
        finalResponse = result.rewrite;
        wasBlocked = true;
        wasRewritten = true;
      } else if (!result.blocked && result.rewrite) {
        finalResponse = result.rewrite;
        wasRewritten = true;
      }
    }
  }

  return { results, finalResponse, wasRewritten, wasBlocked };
}
