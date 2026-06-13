// ─────────────────────────────────────────────────────────────────────────────
// Text normalization utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeText(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Check if normalized text contains a keyword. */
export function containsKeyword(text: string, keyword: string): boolean {
  const norm = normalizeText(text);
  const kw = normalizeText(keyword);
  return norm.includes(kw);
}

/** Extract a single integer from text (e.g. "I am 28" → 28). */
export function extractAge(text: string): number | null {
  const match = text.match(/\b(1[6-9]|[2-7][0-9]|80)\b/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/** Detect affirmative confirmation phrases. */
export function isAffirmative(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm === "yes" ||
    norm === "yeah" ||
    norm === "yep" ||
    norm === "sure" ||
    norm === "ok" ||
    norm === "okay" ||
    norm === "correct" ||
    norm === "confirm" ||
    norm === "confirmed" ||
    norm === "go ahead" ||
    norm === "book it" ||
    norm === "that is correct" ||
    norm === "that's correct" ||
    norm.includes("yes please") ||
    norm.includes("go ahead") ||
    norm.includes("confirm that") ||
    norm.includes("book it")
  );
}

/** Detect cancellation phrases. */
export function isCancellation(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("cancel") ||
    norm.includes("stop") ||
    norm.includes("nevermind") ||
    norm.includes("never mind") ||
    norm.includes("forget it") ||
    norm.includes("start over")
  );
}

/** Detect human handoff requests. */
export function wantsHumanHandoff(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes("speak to someone") ||
    norm.includes("speak to a person") ||
    norm.includes("talk to someone") ||
    norm.includes("talk to a person") ||
    norm.includes("human") ||
    norm.includes("real person") ||
    norm.includes("agent") ||
    norm.includes("representative")
  );
}

/** Extract gear preference from text. */
export function extractGear(text: string): "manual" | "automatic" | null {
  const norm = normalizeText(text);
  if (norm.includes("automatic") || norm.includes("auto")) return "automatic";
  if (norm.includes("manual")) return "manual";
  return null;
}

/** Extract email address from text. */
export function extractEmail(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? null;
}

/** Extract simple spoken customer name patterns. */
export function extractCustomerName(text: string): string | null {
  const match = text.match(
    /\b(?:i am|i'm|im|my name is|name is|name)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i
  );
  if (!match) return null;

  const raw = match[1]
    .replace(/\b(?:phone|phonenumber|phone number|email|and|please)\b.*$/i, "")
    .trim();

  return raw.length > 0 ? raw : null;
}

/**
 * Extract SuccessVan customer phone input format.
 * The web app stores local UK numbers as 10 digits without +44, e.g. 7346323799.
 */
export function extractUkPhone(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith("44")) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith("440")) return digits.slice(3);
  return null;
}
