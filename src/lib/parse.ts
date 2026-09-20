import Papa from "papaparse";
import * as XLSX from "xlsx";
import { ColumnSchema } from "./types";
import { normalizeKey } from "./keys";
import { inferColumnType, looksLikeDate } from "./utils";

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
  const headers = result.meta.fields ?? [];
  const rows = result.data;
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
    const headers = headerRow.map((h, i) => (isBlankCell(h) ? `Column_${i + 1}` : String(h).trim()));
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

function buildParsedFile(headers: string[], rows: Record<string, string>[]): ParsedFile {
  const columns: ColumnSchema[] = headers.map((name) => {
    const values = rows.map((r) => String(r[name] ?? ""));
    const type = inferColumnType(values);
    const nullable = values.some((v) => v === "" || v === "null" || v === "undefined");

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
    return {
      name,
      type,
      nullable,
      sample: values.slice(0, 3),
      distinctCount: distinct.size,
      nullCount: keys.length - present.length,
      isUnique: present.length > 0 && distinct.size === present.length,
      ...(rawDistinct.length > 0 && rawDistinct.length <= 12 && type !== "number" ? { distinctValues: rawDistinct } : {}),
    };
  });

  // Coerce cell values to their inferred type so the query engine can do
  // real numeric/date comparisons instead of string comparisons.
  const typedRows: Record<string, unknown>[] = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      const raw = r[col.name] ?? "";
      out[col.name] = coerceValue(raw, col.type);
    }
    return out;
  });

  const { rows: cleanRows, notes } = excludeSummaryRows(typedRows, columns);
  return { rows: cleanRows, columns, rowCount: cleanRows.length, ...(notes.length ? { notes } : {}) };
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
function excludeSummaryRows(rows: Record<string, unknown>[], columns: ColumnSchema[]): { rows: Record<string, unknown>[]; notes: string[] } {
  if (rows.length < 3) return { rows, notes: [] };
  const numeric = columns.filter((c) => c.type === "number").map((c) => c.name);
  const text = columns.filter((c) => c.type !== "number").map((c) => c.name);
  if (numeric.length === 0) return { rows, notes: [] };

  const candidates = rows
    .map((r, i) => ({ r, i, label: text.map((c) => String(r[c] ?? "").trim()).find((v) => SUMMARY_LABEL.test(v)) }))
    .filter((x) => x.label);
  if (candidates.length === 0) return { rows, notes: [] };

  const candidateIdx = new Set(candidates.map((c) => c.i));
  const sums = new Map<string, number>();
  for (const col of numeric) {
    let total = 0;
    rows.forEach((r, i) => { if (!candidateIdx.has(i) && typeof r[col] === "number") total += r[col] as number; });
    sums.set(col, total);
  }

  const confirmed = new Set<number>();
  const notes: string[] = [];
  for (const c of candidates) {
    const present = numeric.filter((col) => typeof c.r[col] === "number");
    if (present.length === 0) continue;
    const matches = present.every((col) => {
      const v = c.r[col] as number, expected = sums.get(col) ?? 0;
      return Math.abs(v - expected) <= Math.max(0.01, Math.abs(expected) * 0.001);
    });
    if (matches) {
      confirmed.add(c.i);
      notes.push(`Excluded a summary row labelled "${c.label}" — its ${present.join(", ")} equalled the sum of all other rows, so counting it would double every total.`);
    }
  }
  if (confirmed.size === 0) return { rows, notes: [] };
  return { rows: rows.filter((_, i) => !confirmed.has(i)), notes };
}

function coerceValue(raw: string, type: ColumnSchema["type"]): unknown {
  if (raw === "") return null;
  if (type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === "boolean") return ["true", "1", "yes"].includes(raw.toLowerCase());
  if (type === "date") {
    // Defense in depth: even within a column already inferred as "date",
    // don't let Date.parse's leniency coerce an individual off-shape value
    // (e.g. a stray non-date cell) into a fabricated date — keep it as the
    // original string instead of guessing.
    if (!looksLikeDate(raw)) return raw;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? raw : new Date(t).toISOString();
  }
  return raw;
}
