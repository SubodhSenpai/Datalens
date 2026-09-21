import { isPlaceholder, parseNumberLoose } from "./clean";
import { DatasetFile, ColumnSchema, SUPPORTED_FORMATS, MAX_FILE_SIZE_MB } from "./types";

// ─── File Validation ──────────────────────────────────────────────────────────

export function validateFile(file: File): { valid: boolean; error?: string } {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  if (!SUPPORTED_FORMATS.includes(ext)) {
    return { valid: false, error: `Unsupported format. Use CSV or XLSX.` };
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return { valid: false, error: `File exceeds ${MAX_FILE_SIZE_MB}MB limit.` };
  }
  return { valid: true };
}

// ─── File Size Formatting ─────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ─── Session Storage Helpers ──────────────────────────────────────────────────

export function generateSessionId(): string {
  return "sess_" + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export function getTotalSize(datasets: DatasetFile[]): number {
  return datasets.reduce((acc, d) => acc + d.size, 0);
}

// ─── Column Type Inference ────────────────────────────────────────────────────

// JS's Date.parse() is far too permissive on its own to use as a date
// detector — e.g. Date.parse("Grocery Item 1523") succeeds (it happily
// parses arbitrary strings containing a number as some date), which would
// misclassify ordinary text columns (product names, SKUs, addresses) as
// dates and silently corrupt their values on coercion. This allowlist of
// actual date shapes is checked FIRST; Date.parse only confirms parseability
// of a string that already looks like a real date.
const DATE_PATTERNS: RegExp[] = [
  /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/, // ISO 8601, also "YYYY-MM-DD HH:mm" as SQL/Excel export it
  /^\d{4}\/\d{1,2}\/\d{1,2}( \d{1,2}:\d{2}(:\d{2})?)?$/, // YYYY/MM/DD, optional time
  /^\d{1,2}\/\d{1,2}\/\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/, // MM/DD/YYYY or DD/MM/YYYY, optional time
  /^\d{1,2}-\d{1,2}-\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/, // MM-DD-YYYY or DD-MM-YYYY, optional time
  /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/, // "January 5, 2024" / "Jan 5 2024"
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}$/, // "5 January 2024"
  /^\d{1,2}[-\/][A-Za-z]{3,9}[-\/]\d{4}$/, // "01-Aug-2021" / "5/Jan/2024"
  /^[A-Za-z]{3,9}[-\/]\d{1,2}[-\/]\d{4}$/, // "Aug-01-2021"
];

export function looksLikeDate(value: string): boolean {
  return DATE_PATTERNS.some((p) => p.test(value.trim()));
}

/**
 * dd/mm/yyyy, mm/dd/yyyy, dd-mm-yyyy, with optional time. Date.parse reads
 * these US-first and rejects a day above 12, so parse.ts handles them with
 * the day order decided per column; here it only marks them parseable.
 */
export const NUMERIC_DATE = /^(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function inferColumnType(values: string[]): ColumnSchema["type"] {
  const nonEmpty = values.filter((v) => v !== "" && v !== null && v !== undefined && !isPlaceholder(v));
  if (nonEmpty.length === 0) return "unknown";

  // Formatted numbers ("₹1,20,000", "12%", "(500)") are numbers. A column is
  // numeric when at least 98% of its filled cells read as one — a stray
  // "TBD" in a salary column does not turn the whole column into text.
  const numeric = nonEmpty.filter((v) => parseNumberLoose(v) !== null).length;
  const tolerated = Math.max(1, Math.floor(nonEmpty.length * 0.02));
  const isNumber = numeric === nonEmpty.length || (numeric >= 3 && numeric >= nonEmpty.length - tolerated);
  if (isNumber) return "number";

  const isBoolean = nonEmpty.every((v) => ["true", "false", "0", "1", "yes", "no"].includes(v.toLowerCase()));
  if (isBoolean) return "boolean";

  const isDate = nonEmpty.slice(0, 10).every((v) => looksLikeDate(v) && (NUMERIC_DATE.test(v.trim()) || !isNaN(Date.parse(v))));
  if (isDate) return "date";

  return "string";
}

// ─── Chart color palette ──────────────────────────────────────────────────────

export const CHART_COLORS = [
  "#6E8F63", // sage dark
  "#E4785B", // terracotta
  "#F2C744", // mustard
  "#232C42", // navy
  "#A9CBE0", // sky
  "#C79B1E", // mustard dark
  "#8B7355", // warm brown
  "#5B7A8C", // slate blue
];
