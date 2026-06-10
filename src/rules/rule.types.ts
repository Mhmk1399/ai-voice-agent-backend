// ─────────────────────────────────────────────────────────────────────────────
// Rule Types
// ─────────────────────────────────────────────────────────────────────────────

export type RuleSeverity = "hard" | "soft";

export interface RuleResult {
  ruleId: string;
  severity: RuleSeverity;
  passed: boolean;
  message?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RuleContext = Record<string, any>;

export interface Rule<TCtx = RuleContext> {
  id: string;
  severity: RuleSeverity;
  description: string;
  check(ctx: TCtx): RuleResult;
}
