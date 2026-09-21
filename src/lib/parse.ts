import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ColumnSchema } from "./types";
import { normalizeKey } from "./keys";
import { inferColumnType, looksLikeDate, NUMERIC_DATE } from "./utils";
import { cleanHeaders, cleanText, isBlankValue, parseNumberLoose, unifySpellings } from "./clean";

export interface ParsedFile {
  rows: Record<string, unknown>[];
  columns: ColumnSchema[];
  rowCount: number;
  /** Data-quality facts worth telling the user (a summary row excluded, …). */
  notes?: string[];
}

export function parseCSVBuffer(buffer: Buffer): ParsedFile {
  const text = buffer.toString("utf-8");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const rawHeaders = result.meta.fields ?? [];
  const headers = cleanHeaders(rawHeaders);
  // Papa keys rows by the raw header text; re-key by the cleaned names.
  const rows = result.data.map((r) => { const o: Record<string, string> = {}; rawHeaders.forEach((h, i) => { o[headers[i]] = r[h] ?? ""; }); return o; });
  return buildParsedFile(headers, rows);
}

export interface ParsedSheet extends ParsedFile {
  sheetName: string;
}

const isBlankCell = (c: unknown) => c === null || c === undefined || String(c).trim() === "";

// Real spreadsheets rarely start with a clean header on row 1 — title rows,
// a "Generated: <date>" line, and blank spacer rows above the real header
// are common. Walk down until we find a row with >=2 filled cells that is
// immediately followed by a row that also has data — that's the header.
function detectHeaderRow(raw: unknown[][]): number {
  for (let i = 0; i < Math.min(raw.length, 15); i++) {
    const row = (raw[i] ?? []) as unknown[];
    const filled = row.filter((c) => !isBlankCell(c)).length;
    if (filled < 2) continue;
    const next = (raw[i + 1] ?? []) as unknown[];
    if (next.filter((c) => !isBlankCell(c)).length < 1) continue;
    return i;
  }
  return 0;
}

// A workbook can hold several sheets that are each a distinct table (a
// lookup sheet, a bonus sheet, a targets sheet) — treating only
// SheetNames[0] as "the file" silently throws away real data. Every sheet
// that resolves to an actual table (header + >=1 data row) becomes its own
// dataset; a sheet that's just prose/notes ("This sheet has no table.") is
// skipped rather than turned into a garbage single-column dataset.
export function parseXLSXBuffer(buffer: Buffer): ParsedSheet[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheets: ParsedSheet[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
    if (raw.length < 2) continue;

    const headerIdx = detectHeaderRow(raw);
    const headerRow = raw[headerIdx] as unknown[];
    const headers = cleanHeaders(headerRow.map((h) => (isBlankCell(h) ? "" : String(h))));
    if (headers.length < 2) continue;

    const dataRows = raw.slice(headerIdx + 1).filter((r) => (r as unknown[]).some((c) => !isBlankCell(c)));
    if (dataRows.length === 0) continue;

    const rows: Record<string, string>[] = dataRows.map((r) => {
      const arr = r as unknown[];
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => { obj[h] = isBlankCell(arr[i]) ? "" : String(arr[i]); });
      return obj;
    });
    sheets.push({ sheetName, ...buildParsedFile(headers, rows) });
  }

  return sheets;
}

function buildParsedFile(rawHeaders: string[], rawRows: Record<string, string>[]): ParsedFile {
  // Cleaning pass: text trimmed and placeholders blanked, columns with no
  // value anywhere dropped, category spellings unified. All reported.
  const cleaningNotes: string[] = [];
  let headers = rawHeaders;
  let rows = rawRows.map((r) => { const o: Record<string, string> = {}; for (const h of headers) o[h] = isBlankValue(r[h]) ? "" : cleanText(String(r[h])); return o; });
  const blankCols = headers.filter((h) => rows.every((r) => r[h] === ""));
  if (blankCols.length && blankCols.length < headers.length) {
    headers = headers.filter((h) => !blankCols.includes(h));
    cleaningNotes.push(`Dropped ${blankCols.length} column${blankCols.length === 1 ? "" : "s"} with no values (${blankCols.join(", ")}).`);
  }
  const nonBlankRows = rows.filter((r) => headers.some((h) => r[h] !== ""));
  if (nonBlankRows.length < rows.length) cleaningNotes.push(`Skipped ${rows.length - nonBlankRows.length} completely blank row${rows.length - nonBlankRows.length === 1 ? "" : "s"}.`);
  rows = nonBlankRows;
  for (const h of headers) {
    const colValues = rows.map((r) => r[h]);
    if (inferColumnType(colValues) !== "string") continue;
    const { values, merged } = unifySpellings(colValues);
    if (merged.length) {
      rows.forEach((r, i) => { r[h] = values[i]; });
      cleaningNotes.push(`Unified spellings in "${h}": ${merged.map((m) => `${m.variants.map((v) => `"${v}"`).join(", ")} → "${m.canonical}"`).join("; ")} — case and spacing variants of one value would otherwise count as separate groups.`);
    }
  }

  const columns = profileColumns(headers, rows);

  // Coerce cell values to their inferred type so the query engine can do
  // real numeric/date comparisons instead of string comparisons.
  const typedRows = coerceRows(rows, columns);

  const { rows: cleanRows, notes: summaryNotes, kept } = excludeSummaryRows(typedRows, columns);
  const notes = [...cleaningNotes, ...formatNotes(columns), ...sentinelNotes(columns), ...summaryNotes];
  if (summaryNotes.length === 0) return { rows: cleanRows, columns, rowCount: cleanRows.length, ...(notes.length ? { notes } : {}) };

  // A summary row was dropped: the profile (distinct counts, uniqueness,
  // ranges, sums) must describe the rows that were KEPT, or the file would
  // report one more distinct id than it has rows.
  const keptRaw = rows.filter((_, i) => kept.has(i));
  const cleanColumns = profileColumns(headers, keptRaw);
  return { rows: coerceRows(keptRaw, cleanColumns), columns: cleanColumns, rowCount: keptRaw.length, notes: [...cleaningNotes, ...formatNotes(cleanColumns), ...sentinelNotes(cleanColumns), ...summaryNotes] };
}

function coerceRows(rows: Record<string, string>[], columns: ColumnSchema[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const raw = r[col.name] ?? "";
      const v = coerceValue(raw, col.type, col.dayOrder);
      out[col.name] = col.sentinel !== undefined && v === col.sentinel ? null : v;
    }
    return out;
  });
}

function formatNotes(columns: ColumnSchema[]): string[] {
  const out: string[] = [];
  for (const c of columns) {
    if (c.numberFormat) out.push(`"${c.name}" was formatted text (${c.numberFormat === "currency" ? "currency signs" : c.numberFormat === "percent" ? "percent signs" : c.numberFormat === "parentheses" ? "accounting parentheses for negatives" : c.numberFormat === "unit-words" ? "scale words such as lakh/crore/k/million" : "thousand separators"}) and was read as numbers.`);
    if (c.unparsableCount) out.push(`${c.unparsableCount} cell${c.unparsableCount === 1 ? "" : "s"} of "${c.name}" could not be read as a number and were treated as blank.`);
  }
  return out;
}

function sentinelNotes(columns: ColumnSchema[]): string[] {
  return columns
    .filter((c) => c.sentinel !== undefined)
    .map((c) => `Treated ${c.sentinelCount!.toLocaleString("en-US")} cells of "${c.name}" holding ${c.sentinel} as blank — an all-nines value far outside the column's other values is a missing-value code, not a reading, and would otherwise distort every average and total.`);
}

/**
 * Sensor and survey exports encode "no reading" as a number: -999, -9999,
 * 9999. Summed or averaged, one such code wrecks every figure. A value is
 * taken as a code only when ALL of these hold: it is an all-nines integer of
 * at least three digits, it occurs in at least 5 cells and 0.2% of rows,
 * and it lies FAR outside the other values — more than three times their
 * spread beyond them (a 999 that is merely the top score is kept).
 */
const SENTINEL_SHAPE = /^-?9{3,}$/;
function detectSentinel(values: string[]): { value: number; count: number } | undefined {
  const counts = new Map<string, number>();
  let numeric = 0;
  for (const v of values) {
    const n = parseNumberLoose(v);
    if (!n) continue;
    numeric++;
    const t = String(n.value);
    if (SENTINEL_SHAPE.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count < 5 || count < numeric * 0.002) return undefined;
  const code = Number(best);
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    const p = parseNumberLoose(v);
    if (!p || p.value === code) continue;
    const n = p.value;
    if (n < lo) lo = n; if (n > hi) hi = n;
  }
  if (lo === Infinity) return undefined;
  const spread = Math.max(hi - lo, Math.abs(hi) * 0.5, 1);
  return code < lo - 3 * spread || code > hi + 3 * spread ? { value: code, count } : undefined;
}

function profileColumns(headers: string[], rows: Record<string, string>[]): ColumnSchema[] {
  return headers.map((name) => {
    const rawValues = rows.map((r) => String(r[name] ?? ""));
    const type = inferColumnType(rawValues);
    // A missing-value code is a blank for every statistic below.
    const sentinel = type === "number" ? detectSentinel(rawValues) : undefined;
    let numberFormat: ColumnSchema["numberFormat"];
    let unparsableCount = 0;
    // A numeric column is read through the loose parser: formatted text
    // becomes its number, and a cell that is not a number becomes blank.
    const values = rawValues.map((v) => {
      if (type !== "number") return v;
      if (v === "") return v;
      const n = parseNumberLoose(v);
      if (!n) { unparsableCount++; return ""; }
      if (n.format && !numberFormat) numberFormat = n.format;
      if (sentinel && n.value === sentinel.value) return "";
      return String(n.value);
    });
    const nullable = values.some((v) => v === "");

    // Profiled once, here, because this is the only place every file passes
    // through. Uniqueness is what distinguishes the "one" side of a
    // relationship from a column that merely shares a name with another
    // file's — without it, an id column with one row per entity and an id
    // column with six rows per entity look identical.
    const keys = values.map(normalizeKey);
    const present = keys.filter((k): k is string => k !== null);
    const distinct = new Set(present);

    // A handful of distinct values is a vocabulary worth showing whole.
    const rawDistinct = Array.from(new Set(values.filter((v) => v !== "")));
    const dayOrder = type === "date" ? detectDayOrder(values) : undefined;
    const range = columnRange(values, type, dayOrder);
    return {
      name,
      type,
      nullable,
      sample: values.slice(0, 3),
      distinctCount: distinct.size,
      nullCount: keys.length - present.length,
      isUnique: present.length > 0 && distinct.size === present.length,
      ...(rawDistinct.length > 0 && rawDistinct.length <= 12 && type !== "number" ? { distinctValues: rawDistinct } : {}),
      ...range,
      ...(dayOrder ? { dayOrder } : {}),
      ...(sentinel ? { sentinel: sentinel.value, sentinelCount: sentinel.count } : {}),
      ...(numberFormat ? { numberFormat } : {}),
      ...(unparsableCount ? { unparsableCount } : {}),
    };
  });
}

// The span of a numeric or date column, so a file can be described as
// "covers 2025-01-03 to 2025-06-30" or "amount 12.50 to 9,800" without
// anyone opening it.
function columnRange(values: string[], type: ColumnSchema["type"], dayOrder?: DayOrder): { min?: number | string; max?: number | string } {
  if (type === "number") {
    let min = Infinity, max = -Infinity;
    for (const v of values) {
      const n = coerceValue(v, "number");
      if (typeof n === "number" && Number.isFinite(n)) { if (n < min) min = n; if (n > max) max = n; }
    }
    return min <= max ? { min, max } : {};
  }
  if (type === "date") {
    // Coerced dates are ISO strings, which order correctly as text.
    let min: string | null = null, max: string | null = null;
    for (const v of values) {
      const d = coerceValue(v, "date", dayOrder);
      if (typeof d === "string" && d !== v && /^\d{4}-\d{2}-\d{2}T/.test(d)) {
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
    }
    return min && max ? { min: min.slice(0, 10), max: max.slice(0, 10) } : {};
  }
  return {};
}

const SUMMARY_LABEL = /^(grand\s+)?(sub\s*)?totals?\s*:?$|^sum\s*:?$|^overall\s*:?$/i;

/**
 * Spreadsheets exported from finance and BI tools often carry a summary row
 * at the bottom — "TOTAL" with the column sums. Summed along with the data
 * it silently doubles every total. A row is treated as a summary row only
 * when BOTH hold: a text cell reads like a total label, AND every numeric
 * cell it has equals the sum of that column over all the other rows. The
 * arithmetic is what makes this safe — a customer named "Total Systems" has
 * a label but not the sums.
 */
function excludeSummaryRows(rows: Record<string, unknown>[], columns: ColumnSchema[]): { rows: Record<string, unknown>[]; notes: string[]; kept: Set<number> } {
  const all = () => ({ rows, notes: [], kept: new Set(rows.map((_, i) => i)) });
  if (rows.length < 3) return all();
  const numeric = columns.filter((c) => c.type === "number").map((c) => c.name);
  const text = columns.filter((c) => c.type !== "number").map((c) => c.name);
  if (numeric.length === 0) return all();

  const candidates = rows
    .map((r, i) => ({ r, i, label: text.map((c) => String(r[c] ?? "").trim()).find((v) => SUMMARY_LABEL.test(v)) }))
    .filter((x) => x.label);
  if (candidates.length === 0) return all();

  const candidateIdx = new Set(candidates.map((c) => c.i));
  const sums = new Map<string, number>();
  for (const col of numeric) {
    let total = 0;
    rows.forEach((r, i) => { if (!candidateIdx.has(i) && typeof r[col] === "number") total += r[col] as number; });
    sums.set(col, total);
  }

  const confirmed = new Set<number>();
  const notes: string[] = [];
  // A label sitting in a column that is otherwise an identifier (unique on
  // every other row) marks a summary row even when its figure is not the
  // exact column sum — a hand-typed or stale total is still not a record.
  const idColumns = text.filter((col) => {
    const others = rows.filter((_, i) => !candidateIdx.has(i)).map((r) => normalizeKey(r[col])).filter((k) => k !== null);
    // Near-unique is enough: a duplicated record elsewhere does not make the id column a category.
    return others.length >= 3 && new Set(others).size >= others.length - Math.max(1, Math.floor(others.length * 0.1));
  });
  for (const c of candidates) {
    const present = numeric.filter((col) => typeof c.r[col] === "number");
    if (present.length === 0) continue;
    const matches = present.every((col) => {
      const v = c.r[col] as number, expected = sums.get(col) ?? 0;
      return Math.abs(v - expected) <= Math.max(0.01, Math.abs(expected) * 0.001);
    });
    const labelInIdColumn = idColumns.some((col) => SUMMARY_LABEL.test(String(c.r[col] ?? "").trim()));
    if (matches) {
      confirmed.add(c.i);
      notes.push(`Excluded a summary row labelled "${c.label}" — its ${present.join(", ")} equalled the sum of all other rows, so counting it would double every total.`);
    } else if (labelInIdColumn) {
      confirmed.add(c.i);
      notes.push(`Excluded a row labelled "${c.label}" in the identifier column — a summary line, not a record. Its figure (${present.map((col) => `${col} ${c.r[col]}`).join(", ")}) does not equal the column sum (${present.map((col) => `${col} ${Math.round((sums.get(col) ?? 0) * 100) / 100}`).join(", ")}), so it was stale or hand-typed.`);
    }
  }
  if (confirmed.size === 0) return all();
  const kept = new Set(rows.map((_, i) => i).filter((i) => !confirmed.has(i)));
  return { rows: rows.filter((_, i) => kept.has(i)), notes, kept };
}

type DayOrder = NonNullable<ColumnSchema["dayOrder"]>;


/**
 * "07/04/2025" is 7 April in most of the world and 4 July in the US; the
 * only evidence is the column itself. A value with its first part above 12
 * proves day-first, one with its second part above 12 proves month-first,
 * and the whole column is read the same way — never one row as DMY and the
 * next as MDY. With no evidence the US reading is kept, as Date.parse does.
 */
function detectDayOrder(values: string[]): DayOrder | undefined {
  let sawNumeric = false;
  for (const v of values) {
    const m = NUMERIC_DATE.exec(v.trim());
    if (!m) continue;
    sawNumeric = true;
    const first = Number(m[1]), second = Number(m[3]);
    if (first > 12 && second <= 12) return "dmy";
    if (second > 12 && first <= 12) return "mdy";
  }
  return sawNumeric ? "mdy" : undefined;
}

function parseNumericDate(raw: string, order: DayOrder): number {
  const m = NUMERIC_DATE.exec(raw);
  if (!m) return NaN;
  const a = Number(m[1]), b = Number(m[3]), year = Number(m[4]);
  const day = order === "dmy" ? a : b, month = order === "dmy" ? b : a;
  if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
  return Date.UTC(year, month - 1, day, Number(m[5] ?? 0), Number(m[6] ?? 0), Number(m[7] ?? 0));
}

const ISO_NO_ZONE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * "2025-01-01 02:30" carries no time zone. Date.parse reads such a value in
 * the SERVER's zone and the ISO form then shifts it — on a UTC+5:30 machine
 * that timestamp lands in December. A zone-less value is taken as written.
 */
const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const YMD_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
// "01-Aug-2021", "5 January 2024", "Aug-01-2021", "January 5, 2024"
const DAY_MONTH_YEAR = /^(\d{1,2})[-\/ ]([A-Za-z]{3,9})\.?,?[-\/ ](\d{4})$/;
const MONTH_DAY_YEAR = /^([A-Za-z]{3,9})\.?[-\/ ](\d{1,2}),?[-\/ ](\d{4})$/;
const monthIndex = (name: string) => MONTHS_SHORT.indexOf(name.slice(0, 3).toLowerCase());

/**
 * Every date shape the profiler accepts is parsed HERE as a calendar date
 * (UTC), never through Date.parse's local-time reading — on a UTC+5:30
 * machine that reading moved "01-Aug-2021" to the evening of 31 July.
 */
function parseIsoLike(value: string): number {
  let m = ISO_NO_ZONE.exec(value) ?? YMD_SLASH.exec(value);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  m = DAY_MONTH_YEAR.exec(value);
  if (m) { const mi = monthIndex(m[2]); return mi < 0 ? NaN : Date.UTC(Number(m[3]), mi, Number(m[1])); }
  m = MONTH_DAY_YEAR.exec(value);
  if (m) { const mi = monthIndex(m[1]); return mi < 0 ? NaN : Date.UTC(Number(m[3]), mi, Number(m[2])); }
  return Date.parse(value);
}

function coerceValue(raw: string, type: ColumnSchema["type"], dayOrder?: DayOrder): unknown {
  if (raw === "") return null;
  if (type === "number") {
    const n = parseNumberLoose(raw);
    return n ? n.value : null;
  }
  if (type === "boolean") return ["true", "1", "yes"].includes(raw.toLowerCase());
  if (type === "date") {
    // Defense in depth: even within a column already inferred as "date",
    // don't let Date.parse's leniency coerce an individual off-shape value
    // (e.g. a stray non-date cell) into a fabricated date — keep it as the
    // original string instead of guessing.
    if (!looksLikeDate(raw)) return raw;
    const trimmed = raw.trim();
    const t = dayOrder && NUMERIC_DATE.test(trimmed) ? parseNumericDate(trimmed, dayOrder) : parseIsoLike(trimmed);
    return Number.isNaN(t) ? raw : new Date(t).toISOString();
  }
  return raw;
}
