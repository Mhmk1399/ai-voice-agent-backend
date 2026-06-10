import { contextProvider } from "../../context/successvan-context.provider.js";
import { normalizeText } from "../../utils/normalize-text.js";
import type { Tool, ToolOutput } from "../tool.types.js";
import type { OfficeContext } from "../../context/context-provider.interface.js";

// ─────────────────────────────────────────────────────────────────────────────
// Office alias table
// Maps normalized user phrases → patterns to look for in office name/address.
// ─────────────────────────────────────────────────────────────────────────────

const OFFICE_ALIASES: Record<string, string[]> = {
  london: ["london", "cricklewood", "north west"],
  cricklewood: ["cricklewood"],
  "north west london": ["north west", "cricklewood"],
  "nw london": ["north west", "cricklewood"],
  "north london": ["north", "cricklewood"],
  "south london": ["south"],
  "east london": ["east"],
  "west london": ["west"],
  luton: ["luton"],
  birmingham: ["birmingham"],
  manchester: ["manchester"],
};

const CONFIDENCE_THRESHOLD = 55;
const AMBIGUITY_GAP = 20;

interface ResolveOfficeInput {
  userText: string;
}

interface ResolveOfficeResult {
  match?: OfficeContext;
  ambiguous?: boolean;
  candidates?: Array<{ office: OfficeContext; score: number }>;
  message?: string;
}

function scoreOffice(office: OfficeContext, normInput: string): number {
  const normName = normalizeText(office.name);
  const normAddress = normalizeText(office.address ?? "");

  // Exact match on name
  if (normName === normInput) return 100;

  // Alias match
  const aliasPatterns = OFFICE_ALIASES[normInput];
  if (aliasPatterns) {
    const combined = normName + " " + normAddress;
    const matched = aliasPatterns.filter((p) => combined.includes(p)).length;
    if (matched > 0) return 70 + matched * 5;
  }

  // Partial name match
  if (normName.includes(normInput) || normInput.includes(normName)) return 65;
  if (normAddress.includes(normInput)) return 60;

  // Word overlap
  const inputWords = normInput.split(" ");
  const nameWords = normName.split(" ");
  const overlap = inputWords.filter((w) => nameWords.includes(w)).length;
  if (overlap > 0) return 40 + overlap * 10;

  return 0;
}

export const resolveOfficeTool: Tool<ResolveOfficeInput, ResolveOfficeResult> = {
  name: "resolveOffice",
  description:
    "Resolve a user's office description to the best matching SuccessVan office.",

  async execute(input: ResolveOfficeInput): Promise<ToolOutput & { data?: ResolveOfficeResult }> {
    const ctx = await contextProvider.load();
    const normInput = normalizeText(input.userText);

    const scored = ctx.offices.map((o) => ({
      office: o,
      score: scoreOffice(o, normInput),
    }));

    const above = scored.filter((s) => s.score >= CONFIDENCE_THRESHOLD);
    above.sort((a, b) => b.score - a.score);

    if (above.length === 0) {
      return {
        success: true,
        data: { message: "No office matched the description." },
      };
    }

    if (
      above.length >= 2 &&
      above[0].score - above[1].score < AMBIGUITY_GAP
    ) {
      return {
        success: true,
        data: {
          ambiguous: true,
          candidates: above.slice(0, 3),
          message: `Did you mean ${above[0].office.name} or ${above[1].office.name}?`,
        },
      };
    }

    return {
      success: true,
      data: { match: above[0].office },
    };
  },
};
