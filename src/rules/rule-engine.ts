import type { Rule, RuleContext, RuleResult } from "./rule.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Rule Engine
// ─────────────────────────────────────────────────────────────────────────────

const ruleRegistry = new Map<string, Rule>();

export function registerRule(rule: Rule): void {
  ruleRegistry.set(rule.id, rule);
}

export function registerRules(rules: Rule[]): void {
  for (const rule of rules) registerRule(rule);
}

export function checkRules(ctx: RuleContext): RuleResult[] {
  const results: RuleResult[] = [];
  for (const rule of ruleRegistry.values()) {
    results.push(rule.check(ctx));
  }
  return results;
}

export function checkRulesSubset(ruleIds: string[], ctx: RuleContext): RuleResult[] {
  const results: RuleResult[] = [];
  for (const id of ruleIds) {
    const rule = ruleRegistry.get(id);
    if (rule) results.push(rule.check(ctx));
  }
  return results;
}

export function hasHardViolation(results: RuleResult[]): boolean {
  return results.some((r) => !r.passed && r.severity === "hard");
}

export function getViolations(results: RuleResult[]): RuleResult[] {
  return results.filter((r) => !r.passed);
}

export function getHardViolations(results: RuleResult[]): RuleResult[] {
  return results.filter((r) => !r.passed && r.severity === "hard");
}
