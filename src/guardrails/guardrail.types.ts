// ─────────────────────────────────────────────────────────────────────────────
// Guardrail Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GuardrailResult {
  guardrailId: string;
  passed: boolean;
  blocked: boolean;
  rewrite?: string;
  reason?: string;
}

export type GuardrailContext = {
  response: string;
} & Record<string, unknown>;

export interface Guardrail<TCtx extends GuardrailContext = GuardrailContext> {
  id: string;
  description: string;
  check(ctx: TCtx): GuardrailResult;
}
