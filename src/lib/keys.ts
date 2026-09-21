import { isPlaceholder } from "./clean";
/**
 * The single definition of "these two cell values are the same join key".
 *
 * This exists because relationship DETECTION and join EXECUTION used to
 * normalize differently: detection compared values with trim+lowercase while
 * the join compared them raw. A pair of files whose keys differed only in
 * case or padding was therefore reported as related — at confidence 1.0 —
 * and then joined to zero rows. The result was an empty table with no error,
 * which is the worst possible way to fail.
 *
 * Both sides now call this, so "detected as joinable" and "actually joins"
 * cannot disagree.
 */

/** Numeric-looking, allowing leading/trailing space and a leading +/-. */
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Canonical form of a cell used as a join key, or `null` for values that must
 * never match anything (blank, or a placeholder standing in for "no value").
 *
 * Numeric strings collapse to their numeric form, so a `site_id` read as the
 * number 1 from one file matches `"001"` read as text from another — the
 * common CSV/XLSX type split that previously made two files unjoinable.
 */
export function normalizeKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (raw === "") return null;

  const lower = raw.toLowerCase();
  // Placeholders are not identities: without this, every row carrying "N/A"
  // in its key column would join to every other such row.
  if (lower === "undefined" || isPlaceholder(raw)) {
    return null;
  }

  if (NUMERIC.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return `n:${n}`;
  }

  // Internal whitespace is collapsed so "Acme  Corp" and "Acme Corp" agree.
  return `s:${lower.replace(/\s+/g, " ")}`;
}

/** Distinct normalized keys in a column, skipping values that can't be keys. */
export function normalizedKeySet(
  rows: Record<string, unknown>[],
  column: string,
  cap = Infinity
): Set<string> {
  const set = new Set<string>();
  const limit = Math.min(rows.length, cap);
  for (let i = 0; i < limit; i++) {
    const k = normalizeKey(rows[i][column]);
    if (k !== null) set.add(k);
  }
  return set;
}
