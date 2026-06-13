import { contextProvider } from "../../context/successvan-context.provider.js";
import { normalizeText } from "../../utils/normalize-text.js";
import type { Tool, ToolOutput } from "../tool.types.js";
import type { CategoryContext } from "../../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Category alias table
// ─────────────────────────────────────────────────────────────────────────────

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
  "3.5t": ["luton", "large"],
};

const CONFIDENCE_THRESHOLD = 55;
const AMBIGUITY_GAP = 20;

interface ResolveCategoryInput {
  userText: string;
  officeId?: string;
}

interface ResolveCategoryResult {
  match?: CategoryContext;
  ambiguous?: boolean;
  candidates?: Array<{ category: CategoryContext; score: number }>;
  message?: string;
}

function scoreCategory(cat: CategoryContext, normInput: string): number {
  const normName = normalizeText(cat.name);
  const normPurpose = normalizeText(cat.purpose ?? "");

  if (normName === normInput) return 100;

  if (normInput.includes("short") && normInput.includes("base")) {
    if (normName.includes("short") && normName.includes("base")) return 92;
  }
  if (normInput.includes("long") && normInput.includes("base")) {
    if (normName.includes("long") && normName.includes("base")) return 88;
  }
  const seatCount = normInput.match(/\b(8|9|14|17)\b/)?.[1];
  if (
    seatCount &&
    (normInput.includes("seat") || normInput.includes("seater")) &&
    normName.includes(seatCount) &&
    (normName.includes("seat") || normName.includes("seater"))
  ) {
    return 92;
  }

  const aliasPatterns = CATEGORY_ALIASES[normInput];
  if (aliasPatterns) {
    const combined = normName + " " + normPurpose;
    const matched = aliasPatterns.filter((p) => combined.includes(p)).length;
    if (matched > 0) return 70 + matched * 5;
  }

  if (normName.includes(normInput) || normInput.includes(normName)) return 65;
  if (normPurpose.includes(normInput)) return 55;

  const inputWords = normInput.split(" ");
  const nameWords = normName.split(" ");
  const overlap = inputWords.filter((w) => nameWords.includes(w)).length;
  if (overlap > 0) return 40 + overlap * 10;

  return 0;
}

export const resolveCategoryTool: Tool<ResolveCategoryInput, ResolveCategoryResult> = {
  name: "resolveCategory",
  description:
    "Resolve a user's van/category description to the best matching SuccessVan category.",

  async execute(input: ResolveCategoryInput): Promise<ToolOutput & { data?: ResolveCategoryResult }> {
    const ctx = await contextProvider.load();
    const normInput = normalizeText(input.userText);

    let cats = ctx.categories;
    if (input.officeId) {
      cats = cats.filter((c) => !c.officeId || c.officeId === input.officeId);
    }

    const scored = cats.map((c) => ({
      category: c,
      score: scoreCategory(c, normInput),
    }));

    const above = scored.filter((s) => s.score >= CONFIDENCE_THRESHOLD);
    above.sort((a, b) => b.score - a.score);

    if (above.length === 0) {
      return {
        success: true,
        data: { message: "No category matched the description." },
      };
    }

    if (
      above.length >= 2 &&
      above[0].score - above[1].score < AMBIGUITY_GAP
    ) {
      const options = above
        .slice(0, 3)
        .map((a) => a.category.name)
        .join(" or ");
      return {
        success: true,
        data: {
          ambiguous: true,
          candidates: above.slice(0, 3),
          message: `Did you mean ${options}?`,
        },
      };
    }

    return {
      success: true,
      data: { match: above[0].category },
    };
  },
};
