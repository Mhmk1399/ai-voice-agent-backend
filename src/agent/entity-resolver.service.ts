import type {
  AgentOfficeContext,
  AgentCategoryContext,
} from "../context/booking-context.service.js";
import type { BookingDraft } from "./types/booking.types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Internal types
// ──────────────────────────────────────────────────────────────────────────────

type ScoreResult = {
  score: number;
  method: "exact" | "alias" | "partial" | "fuzzy";
};

export type ResolverResult = {
  /** Fields resolved for the office, if any. */
  officeDraft?: Pick<BookingDraft, "officeId" | "officeName">;

  /** Fields resolved for the category, if any. */
  categoryDraft?: Pick<BookingDraft, "categoryId" | "categoryName">;

  /**
   * If two candidates score too similarly, we ask the user to clarify
   * rather than silently picking the wrong one.
   * When this is set, officeDraft / categoryDraft are NOT set for that entity.
   */
  ambiguityQuestion?: string;

  /** Names of fields this call successfully resolved, for logging. */
  resolvedFields: string[];
};

// ──────────────────────────────────────────────────────────────────────────────
// Alias tables
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Maps normalised alias strings to patterns that should appear in the office
 * name or address for a match. Extend this as you add branches.
 *
 * Format: { alias: [pattern, ...] }
 * A pattern matches if it appears inside the office's normalised name or address.
 */
const OFFICE_ALIASES: Record<string, string[]> = {
  london: ["london", "cricklewood", "north west"],
  cricklewood: ["cricklewood"],
  "north west london": ["north west", "cricklewood"],
  "nw london": ["north west", "cricklewood"],
  "north london": ["north", "cricklewood"],
  "south london": ["south"],
  "east london": ["east"],
  "west london": ["west"],
};

/**
 * Maps normalised alias strings to patterns that should appear in the category
 * name or purpose for a match.
 *
 * Extend this with regional names (e.g. "transit" → large van in the UK).
 */
const CATEGORY_ALIASES: Record<string, string[]> = {
  luton: ["luton"],
  "luton van": ["luton"],
  "small van": ["small"],
  small: ["small"],
  "medium van": ["medium"],
  medium: ["medium"],
  "large van": ["large"],
  large: ["large"],
  "long wheel base": ["long", "lwb"],
  lwb: ["long", "lwb"],
  "short wheel base": ["short", "swb"],
  swb: ["short", "swb"],
  minibus: ["minibus", "mini bus"],
  "mini bus": ["minibus", "mini bus"],
  transit: ["transit", "large", "medium"],
  sprinter: ["sprinter", "large"],
  "3.5 tonne": ["luton", "large"],
};

// Minimum score to accept a match (0–100 scale).
const CONFIDENCE_THRESHOLD = 55;

// If two candidates are within this gap, ask for clarification instead of
// silently picking the wrong one.
const AMBIGUITY_GAP = 20;

// ──────────────────────────────────────────────────────────────────────────────
// Normalisation helper
// ──────────────────────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. */
function norm(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Scoring functions
// ──────────────────────────────────────────────────────────────────────────────

function scoreOffice(transcript: string, office: AgentOfficeContext): ScoreResult {
  const t = norm(transcript);
  const oName = norm(office.name);
  const oAddr = norm(office.address ?? "");

  // 1. Exact office name appears verbatim in transcript
  if (t.includes(oName)) return { score: 100, method: "exact" };

  // 2. Address tokens overlap (at least 2 significant words)
  const addrTokens = oAddr.split(" ").filter((w) => w.length > 3);
  const tTokens = new Set(t.split(" "));
  const addrOverlap = addrTokens.filter((w) => tTokens.has(w)).length;
  if (addrOverlap >= 2) return { score: 80, method: "partial" };

  // 3. Alias table match
  for (const [alias, patterns] of Object.entries(OFFICE_ALIASES)) {
    if (t.includes(alias)) {
      const hits = patterns.filter((p) => oName.includes(p) || oAddr.includes(p)).length;
      if (hits > 0) return { score: 65 + hits * 5, method: "alias" };
    }
  }

  // 4. Partial office name token overlap
  const nameTokens = oName.split(" ").filter((w) => w.length > 3);
  const nameOverlap = nameTokens.filter((w) => tTokens.has(w)).length;
  if (nameOverlap >= 1) return { score: 45 + nameOverlap * 10, method: "partial" };

  return { score: 0, method: "fuzzy" };
}

function scoreCategory(transcript: string, category: AgentCategoryContext): ScoreResult {
  const t = norm(transcript);
  const cName = norm(category.name);
  const cPurpose = norm(category.purpose ?? "");

  // 1. Exact category name
  if (t.includes(cName)) return { score: 100, method: "exact" };

  // 2. Alias table match
  for (const [alias, patterns] of Object.entries(CATEGORY_ALIASES)) {
    if (t.includes(alias)) {
      const hits = patterns.filter(
        (p) => cName.includes(p) || cPurpose.includes(p)
      ).length;
      if (hits > 0) return { score: 80 + hits * 5, method: "alias" };
    }
  }

  // 3. Category name token overlap
  const cTokens = cName.split(" ").filter((w) => w.length > 3);
  const tTokens = new Set(t.split(" "));
  const nameOverlap = cTokens.filter((w) => tTokens.has(w)).length;
  if (nameOverlap >= 1) return { score: 55 + nameOverlap * 10, method: "partial" };

  // 4. Purpose/description keyword overlap (weak signal)
  const pTokens = cPurpose.split(" ").filter((w) => w.length > 4);
  const purposeOverlap = pTokens.filter((w) => tTokens.has(w)).length;
  if (purposeOverlap >= 2) return { score: 35, method: "fuzzy" };

  return { score: 0, method: "fuzzy" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic entity resolver.
 *
 * Attempts to match offices and categories from the transcript WITHOUT
 * calling GPT. This is fast (microseconds), predictable, and free.
 *
 * GPT is only called for fields this resolver cannot handle:
 *   dates, ages, names, phone numbers.
 *
 * Ambiguity handling:
 *   If two candidates score within AMBIGUITY_GAP of each other, we do NOT
 *   silently pick one. We return an ambiguityQuestion so the orchestrator
 *   can ask the user to clarify before proceeding.
 *
 * Already-resolved fields (officeId, categoryId present in currentDraft)
 * are skipped entirely — we never overwrite confirmed data.
 */
export function resolveEntities(params: {
  transcript: string;
  currentDraft: BookingDraft;
  offices: AgentOfficeContext[];
  categories: AgentCategoryContext[];
}): ResolverResult {
  const { transcript, currentDraft, offices, categories } = params;
  const result: ResolverResult = { resolvedFields: [] };

  // ── Office resolution ────────────────────────────────────────────────────

  if (!currentDraft.officeId) {
    const scored = offices
      .map((o) => ({ office: o, ...scoreOffice(transcript, o) }))
      .filter((s) => s.score >= CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 1) {
      // Clear single winner
      result.officeDraft = {
        officeId: scored[0].office.id,
        officeName: scored[0].office.name,
      };
      result.resolvedFields.push("officeId");
    } else if (
      scored.length >= 2 &&
      scored[0].score - scored[1].score < AMBIGUITY_GAP
    ) {
      // Two offices score too similarly — ask for clarification
      result.ambiguityQuestion = `Did you mean ${scored[0].office.name} or ${scored[1].office.name}?`;
    } else if (scored.length > 1) {
      // Clear leader with enough gap
      result.officeDraft = {
        officeId: scored[0].office.id,
        officeName: scored[0].office.name,
      };
      result.resolvedFields.push("officeId");
    }
  }

  // ── Category resolution ──────────────────────────────────────────────────

  if (!currentDraft.categoryId) {
    const scored = categories
      .map((c) => ({ category: c, ...scoreCategory(transcript, c) }))
      .filter((s) => s.score >= CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 1) {
      result.categoryDraft = {
        categoryId: scored[0].category.id,
        categoryName: scored[0].category.name,
      };
      result.resolvedFields.push("categoryId");
    } else if (
      scored.length >= 2 &&
      scored[0].score - scored[1].score < AMBIGUITY_GAP
    ) {
      // Only set one ambiguity question per resolver call
      if (!result.ambiguityQuestion) {
        result.ambiguityQuestion = `Just to confirm — did you mean a ${scored[0].category.name} or a ${scored[1].category.name}?`;
      }
    } else if (scored.length > 1) {
      result.categoryDraft = {
        categoryId: scored[0].category.id,
        categoryName: scored[0].category.name,
      };
      result.resolvedFields.push("categoryId");
    }
  }

  return result;
}
