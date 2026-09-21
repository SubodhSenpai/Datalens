/**
 * Real-world cleaning rules, applied once at load so every stage downstream
 * (profiling, joins, filters, aggregates) sees the same clean values.
 *
 * Exports rarely arrive tidy: numbers carry currency signs and thousand
 * separators (₹4,80,02,573.75 · $1,200 · 12% · (500) for a negative), blanks
 * are spelled a dozen ways (N/A, -, null, #N/A), headers carry a BOM or
 * padding, and a category is spelled "Active", "active" and " Active ".
 * Left alone, each of those silently changes a calculation: a numeric
 * column typed as text cannot be summed, a placeholder counts as a value,
 * a case variant becomes its own group.
 *
 * Every rule here is conservative and REPORTED (see the notes each caller
 * emits): nothing is guessed silently.
 */

/** Spellings of "no value" that must never be treated as data. */
const PLACEHOLDERS = new Set([
  "-", "--", "—", "–", "n/a", "n.a.", "na", "null", "none", "nil", "nan", "?", "#n/a", "#n/a n/a", "#null!", "#ref!", "#value!", "#div/0!", "#name?", "not available", "not applicable",
]);

export function isPlaceholder(raw: string): boolean {
  return PLACEHOLDERS.has(raw.trim().toLowerCase());
}

/** A cell that carries no value: empty, whitespace, or a placeholder. */
export function isBlankValue(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim();
  return s === "" || isPlaceholder(s);
}

const CURRENCY = /^[\s]*[₹$€£¥₩₽]|[₹$€£¥₩₽]\s*$|^\s*(rs\.?|inr|usd|eur|gbp)\s+|\s+(rs\.?|inr|usd|eur|gbp)\s*$/i;

export interface LooseNumber {
  value: number;
  /** What had to be stripped to read it — reported so the user knows the column was formatted text. */
  format?: "currency" | "percent" | "thousands" | "parentheses" | "unit-words";
}

// "9.5 lakh", "2 crore", "1.2k", "3.5 million": a number with a scale word.
const SCALE_WORDS: [RegExp, number][] = [
  [/^(k|thousand)$/i, 1e3], [/^(m|mn|mm|million)$/i, 1e6], [/^(b|bn|billion)$/i, 1e9],
  [/^(lakh|lakhs|lac|lacs|l)$/i, 1e5], [/^(cr|crore|crores)$/i, 1e7],
];

/**
 * Reads a number out of formatted text. Accepts thousand separators in
 * Western (1,234,567.89) and Indian (12,34,567.89) grouping, a currency
 * sign or code, a trailing percent, accounting-style parentheses for a
 * negative, and Unicode minus. Returns null for anything that is not a
 * number, so "TBD" or a date never becomes 0.
 */
export function parseNumberLoose(raw: unknown): LooseNumber | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? { value: raw } : null;
  let s = String(raw).trim();
  if (s === "" || isPlaceholder(s)) return null;
  let format: LooseNumber["format"] | undefined;
  s = s.replace(/\u2212/g, "-");
  if (/^\(.*\)$/.test(s)) { s = "-" + s.slice(1, -1).trim(); format = "parentheses"; }
  if (CURRENCY.test(s)) { s = s.replace(/[₹$€£¥₩₽]/g, "").replace(/^\s*(rs\.?|inr|usd|eur|gbp)\s+/i, "").replace(/\s+(rs\.?|inr|usd|eur|gbp)\s*$/i, "").trim(); format = "currency"; }
  if (/%$/.test(s)) { s = s.slice(0, -1).trim(); format = format ?? "percent"; }
  let scale = 1;
  const scaled = /^([+-]?[\d.,]+)\s*([A-Za-z]+)$/.exec(s);
  if (scaled) {
    const word = SCALE_WORDS.find(([re]) => re.test(scaled[2]));
    if (!word) return null;
    s = scaled[1]; scale = word[1]; format = format ?? "unit-words";
  }
  if (/,/.test(s)) {
    // Thousand separators must sit in valid groups; "1,2" is not a number.
    if (!/^[+-]?\d{1,3}(,\d{2,3})*(\.\d+)?$/.test(s)) return null;
    s = s.replace(/,/g, "");
    format = format ?? "thousands";
  }
  s = s.replace(/\s+/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const value = Number(s) * scale;
  return Number.isFinite(value) ? { value, format } : null;
}

/** Trims, strips a BOM, collapses inner whitespace; blank or duplicate names are made unique. */
export function cleanHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    let name = String(h ?? "").replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();
    if (!name) name = `Column_${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name}_${n + 1}`;
  });
}

/** Trim and collapse whitespace in a text cell; placeholders become "". */
export function cleanText(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return isPlaceholder(s) ? "" : s;
}

export interface SpellingUnification {
  column: string;
  /** canonical → the variants folded into it */
  merged: { canonical: string; variants: string[] }[];
}

/**
 * "Active", "active" and "ACTIVE" are one category. Within a categorical
 * column, values equal after case-folding and whitespace collapsing are
 * rewritten to the most frequent spelling. Only applied to columns with few
 * distinct values, so free text is never touched.
 */
export function unifySpellings(values: string[], maxDistinct = 50): { values: string[]; merged: SpellingUnification["merged"] } {
  const counts = new Map<string, Map<string, number>>();
  for (const v of values) {
    if (v === "") continue;
    const key = v.toLowerCase();
    const bucket = counts.get(key) ?? counts.set(key, new Map()).get(key)!;
    bucket.set(v, (bucket.get(v) ?? 0) + 1);
  }
  if (counts.size > maxDistinct) return { values, merged: [] };
  const canonical = new Map<string, string>();
  const merged: SpellingUnification["merged"] = [];
  for (const [key, bucket] of counts) {
    if (bucket.size === 1) continue;
    const [best] = [...bucket.entries()].sort((a, b) => b[1] - a[1])[0];
    canonical.set(key, best);
    merged.push({ canonical: best, variants: [...bucket.keys()].filter((v) => v !== best) });
  }
  if (merged.length === 0) return { values, merged };
  return { values: values.map((v) => (v === "" ? v : canonical.get(v.toLowerCase()) ?? v)), merged };
}
