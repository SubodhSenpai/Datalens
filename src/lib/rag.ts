import type { ColumnSchema, DatasetLink } from "./types";
import { stem } from "./schema-linking";
import { normalizeKey } from "./keys";

/**
 * Retrieval for the RAG mode — the alternative to the deterministic planner.
 *
 * What the research says about answering questions over tables with a
 * language model, and what this module does about it:
 *
 * - Reading raw rows is the weakest strategy by far; retrieving the
 *   relevant COLUMNS and the relevant (column, value) CELLS, then computing,
 *   is what works (TableRAG, Chen et al. 2024). So the question is matched
 *   against column names (schema retrieval) and against the distinct values
 *   of categorical columns (cell retrieval), not only against row text.
 * - Every top system on real-CSV question answering computes the answer
 *   rather than asking the model to add rows up (SemEval-2025 Task 8). So
 *   the matched cells become FILTERS, the filtered subsets are computed
 *   here — exact counts, sums, means, per-category breakdowns — and
 *   propagated one hop across detected key links, and those exact facts
 *   are what the model reads.
 * - Pipe-delimited rows are the worst format for a model to read;
 *   key-value lines are the best. Rows are rendered as key-value lines.
 *
 * Retrieval and computation are local and deterministic; the ANSWER is
 * whatever the model writes from them, which is what makes this mode
 * non-deterministic and why its results are labelled unverified.
 */
export interface RagDataset {
  id: string;
  name: string;
  columns: ColumnSchema[];
  rows: Record<string, unknown>[];
  rowCount: number;
  notes?: string[];
}

export interface RetrievedRow {
  datasetId: string;
  datasetName: string;
  index: number;
  score: number;
  row: Record<string, unknown>;
}

/** A question phrase found as a value of a categorical column — a cell hit. */
export interface CellMatch {
  datasetId: string;
  datasetName: string;
  column: string;
  value: string;
  rowsWithValue: number;
  /** Where in the (lower-cased) question the phrase sits, to drop matches nested inside longer ones. */
  span: [number, number];
}

export interface DateMatch {
  datasetId: string;
  datasetName: string;
  column: string;
  year?: number;
  month?: number;
  rows: number;
}

export interface NumericStats { column: string; n: number; sum: number; mean: number; median: number; min: number; max: number }

export interface SubsetFacts {
  datasetId: string;
  datasetName: string;
  /** How the subset was defined, in words. */
  filters: string[];
  /** Filters that came from another file through a key link. */
  propagatedFrom: string[];
  rows: number;
  total: number;
  numeric: NumericStats[];
  breakdowns: { column: string; counts: { value: string; rows: number }[] }[];
  /** Columns with blank cells inside the subset — "3 of the 43 have no end date". */
  blanks: { column: string; blank: number }[];
  /** Distinct values of the file's near-unique id among the subset rows, when the file has duplicate records. */
  distinctIds?: { column: string; n: number };
  rowIndexes: number[];
}

/**
 * A per-category breakdown — the answer to "by <dimension>". The dimension
 * may live in another file than the measures, reached through a key link
 * (loan amounts by the borrowing member's city).
 */
export interface Breakdown {
  dimensionDataset: string;
  dimension: string;
  measureDataset: string;
  /** How the measure rows were assigned to a category, when the dimension is in another file. */
  via?: string;
  measures: string[];
  groups: { value: string; rows: number; /** distinct values of the file's near-unique id among these rows, when the file has duplicate records */ distinctIds?: { column: string; n: number }; stats: NumericStats[]; /** counts by a second, value-matched column ("Open=53, Closed=12") */ split?: { column: string; counts: { value: string; rows: number }[] } }[];
  /** Measure-file rows whose key found no dimension row. */
  unmatchedRows: number;
  /** True when one measure row could belong to several categories (a member with two memberships counts under both). */
  multiValued: boolean;
}

/** Rows on one side of a key link with no partner on the other — "members who never borrowed". */
export interface AntiJoinFact {
  datasetName: string;
  column: string;
  otherDataset: string;
  otherColumn: string;
  unmatched: number;
  total: number;
  /** The unmatched key values, when few enough to list. */
  keys: string[];
}

/** "over 5,000", "more than 100 hours" — a numeric bound on a matched column. */
export interface ThresholdMatch {
  datasetId: string;
  datasetName: string;
  column: string;
  op: ">" | ">=" | "<" | "<=";
  value: number;
}

export interface RagContext {
  /** Rendered text the model reads. */
  text: string;
  retrieved: RetrievedRow[];
  cellMatches: CellMatch[];
  dateMatches: DateMatch[];
  subsets: SubsetFacts[];
  breakdowns: Breakdown[];
  antiJoins: AntiJoinFact[];
  thresholds: ThresholdMatch[];
  /** Columns whose names match the question. */
  matchedColumns: { datasetName: string; column: string }[];
  coverage: { datasetName: string; retrieved: number; total: number; matchedColumns: string[] }[];
  /** True when nothing in the data matched the question: no cell, no column, no row. */
  sampledOnly: boolean;
  queryTerms: string[];
  chars: number;
}

const MAX_ROWS = 30;
const MAX_CONTEXT_CHARS = 26_000;
const HEAD_SAMPLE_PER_FILE = 6;
const MAX_SUBSET_ROWS_SHOWN = 40;
const BREAKDOWN_MAX_VALUES = 12;
// A dimension the question names may have more categories than a subset
// breakdown shows; up to this many are still worth a full table.
const NAMED_DIMENSION_MAX_VALUES = 30;
const MAX_MEASURES_PER_BREAKDOWN = 6;
const ANTI_JOIN_MAX_KEYS = 25;
// Distinct-value index budget per column: a column with more distinct
// values than this is an identifier or free text, not a category.
const MAX_INDEXED_DISTINCT = 2000;
// BM25 constants (Robertson & Zaragoza): term-frequency saturation and
// document-length normalization.
const K1 = 1.2;
const B = 0.75;

const QUESTION_STOP = new Set([
  "the", "and", "for", "are", "was", "were", "what", "which", "who", "how", "many", "much", "show",
  "give", "list", "find", "get", "all", "any", "each", "every", "with", "without", "from", "that",
  "this", "these", "those", "have", "has", "had", "been", "there", "their", "them", "then", "than",
  "but", "not", "did", "does", "our", "out", "into", "about", "vs", "of", "by", "in", "on", "at",
  "to", "is", "it", "as", "an", "a", "or", "we", "do", "its", "me", "please", "can", "you", "per",
]);

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter((t) => t.length > 0).map(stem);
}

export function queryTerms(question: string): string[] {
  return Array.from(new Set(tokenize(question).filter((t) => t.length > 1 && !QUESTION_STOP.has(t))));
}

const isKeyName = (name: string) => /(^|_)(id|key|code|uuid)$/i.test(name) || /^id$/i.test(name);
const isCategorical = (c: ColumnSchema) => (c.type === "string" || c.type === "boolean") && !c.isUnique && (c.distinctCount ?? Infinity) <= MAX_INDEXED_DISTINCT;

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10);
  return String(v);
}

// ─── Schema retrieval: which columns does the question name? ───────────────

function columnNameTokens(column: string): string[] {
  return tokenize(column.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]/g, " "));
}

export interface ColumnMatch { datasetId: string; datasetName: string; column: string; isKey: boolean }

export function matchColumns(terms: string[], datasets: RagDataset[]): ColumnMatch[] {
  const out: ColumnMatch[] = [];
  for (const ds of datasets) {
    for (const c of ds.columns) {
      const toks = columnNameTokens(c.name).filter((t) => !["id", "date", "at", "on", "name", "no", "num"].includes(t));
      if (toks.some((t) => terms.includes(t))) out.push({ datasetId: ds.id, datasetName: ds.name, column: c.name, isKey: isKeyName(c.name) });
    }
  }
  return out;
}

// ─── Cell retrieval: which question phrases are values in the data? ────────

/** lower-case, single-spaced, punctuation-free text for phrase matching. */
function phraseNorm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Every distinct value of every categorical column is checked for
 * appearing in the question as a whole phrase (word-bounded). A value
 * nested inside a longer matched value in the question ("north" inside
 * "north wing") is dropped in favour of the longer one.
 */
export function matchCells(question: string, datasets: RagDataset[]): CellMatch[] {
  const q = " " + phraseNorm(question) + " ";
  const matches: CellMatch[] = [];
  for (const ds of datasets) {
    for (const c of ds.columns.filter(isCategorical)) {
      const counts = new Map<string, { value: string; n: number }>();
      for (const r of ds.rows) {
        const v = r[c.name];
        if (v === null || v === undefined || v === "") continue;
        const key = phraseNorm(String(v));
        if (key.length < 2) continue;
        const e = counts.get(key);
        if (e) e.n++; else counts.set(key, { value: String(v), n: 1 });
      }
      for (const [key, { value, n }] of counts) {
        // Single short tokens ("a1", "q3") must match a whole word; longer phrases too.
        const at = q.indexOf(" " + key + " ");
        if (at < 0) continue;
        // A purely numeric value ("2024", "12") is too ambiguous to be a filter on its own.
        if (/^\d+$/.test(key)) continue;
        matches.push({ datasetId: ds.id, datasetName: ds.name, column: c.name, value, rowsWithValue: n, span: [at, at + key.length + 2] });
      }
    }
  }
  // Drop a match whose span lies inside another match's longer span.
  return matches.filter((m) => !matches.some((o) => o !== m && (o.span[1] - o.span[0]) > (m.span[1] - m.span[0]) && o.span[0] <= m.span[0] && o.span[1] >= m.span[1]));
}

/**
 * The files a question is ABOUT: those holding a matched value, a matched
 * (non-key) column, or whose name appears in the question. Filters are only
 * propagated into these, and a period is only applied to these — otherwise
 * "members in Lisbon" would also select their librarians, their loans and
 * their fines, and "March 2024" would filter every date column in sight.
 */
export function relevantDatasets(terms: string[], datasets: RagDataset[], cells: CellMatch[], columns: ColumnMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of cells) out.add(m.datasetId);
  // A key column names the entity it points AT, not this file.
  for (const m of columns) if (!m.isKey) out.add(m.datasetId);
  for (const ds of datasets) {
    const nameToks = tokenize(ds.name.replace(/\.(csv|xlsx)$/i, "").replace(/[_\-—.]/g, " "));
    if (nameToks.some((t) => t.length > 2 && terms.includes(t))) out.add(ds.id);
  }
  return out;
}

/** A year (and optionally a month name) in the question, applied to the first date column of each relevant file. */
export function matchDates(question: string, datasets: RagDataset[], relevant?: Set<string>): DateMatch[] {
  const yearMatch = question.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;
  const q = question.toLowerCase();
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}[a-z]*\\b`).test(q));
  const month = monthIdx >= 0 ? monthIdx + 1 : undefined;
  if (!year && !month) return [];
  const out: DateMatch[] = [];
  const targets = relevant && relevant.size ? datasets.filter((d) => relevant.has(d.id)) : datasets;
  for (const ds of targets) {
    const dateCol = ds.columns.find((c) => c.type === "date");
    if (!dateCol) continue;
    const rows = ds.rows.filter((r) => inPeriod(r[dateCol.name], year, month)).length;
    out.push({ datasetId: ds.id, datasetName: ds.name, column: dateCol.name, year, month, rows });
  }
  return out;
}

function inPeriod(v: unknown, year?: number, month?: number): boolean {
  if (typeof v !== "string" || !/^\d{4}-\d{2}/.test(v)) return false;
  if (year && Number(v.slice(0, 4)) !== year) return false;
  if (month && Number(v.slice(5, 7)) !== month) return false;
  return true;
}

// ─── Computation: exact facts about the filtered subsets ───────────────────

function numericStats(rows: Record<string, unknown>[], column: string): NumericStats | null {
  const vals: number[] = [];
  for (const r of rows) { const v = r[column]; if (typeof v === "number" && Number.isFinite(v)) vals.push(v); }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  const mid = vals.length >> 1;
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return { column, n: vals.length, sum, mean: sum / vals.length, median, min: vals[0], max: vals[vals.length - 1] };
}

const measureColumns = (ds: RagDataset) => ds.columns.filter((c) => c.type === "number" && !c.isUnique && !isKeyName(c.name)).slice(0, MAX_MEASURES_PER_BREAKDOWN);

/**
 * The column that identifies an entity in this file even though a few rows
 * repeat it (a duplicated record): id-like, no blanks, and distinct on at
 * least 90% of rows but not all. Row counts are then reported alongside
 * distinct counts so a duplicate does not inflate an answer.
 */
function nearUniqueId(ds: RagDataset): ColumnSchema | undefined {
  return ds.columns.find((c) => isKeyName(c.name) && !c.isUnique && (c.nullCount ?? 0) === 0 && typeof c.distinctCount === "number" && c.distinctCount < ds.rowCount && c.distinctCount >= ds.rowCount * 0.9);
}

/** "AG024" → "AG024 (Priya Lopez)": the first text column of the file where that key is unique. */
function keyLabeller(datasets: RagDataset[], links: DatasetLink[], ds: RagDataset, column: string): (v: unknown) => string {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const candidates: { file: RagDataset; keyCol: string }[] = [{ file: ds, keyCol: column }];
  for (const l of links) {
    if (l.datasetIdA === ds.id && l.columnA === column) candidates.push({ file: byId.get(l.datasetIdB)!, keyCol: l.columnB });
    if (l.datasetIdB === ds.id && l.columnB === column) candidates.push({ file: byId.get(l.datasetIdA)!, keyCol: l.columnA });
  }
  for (const { file, keyCol } of candidates) {
    if (!file) continue;
    const key = file.columns.find((c) => c.name === keyCol);
    const labelCol = file.columns.find((c) => c.type === "string" && !isKeyName(c.name) && c.name !== keyCol && (c.distinctCount ?? 0) >= file.rowCount * 0.9);
    if (!key?.isUnique || !labelCol) continue;
    const map = new Map<string, string>();
    for (const r of file.rows) { const k = normalizeKey(r[keyCol]); if (k && !map.has(k)) map.set(k, fmt(r[labelCol.name])); }
    return (v) => { const k = normalizeKey(v); const l = k ? map.get(k) : undefined; return l ? `${fmt(v)} (${l})` : fmt(v); };
  }
  return (v) => fmt(v);
}

const THRESHOLD = /\b(over|above|more than|greater than|exceeding|at least|below|under|less than|fewer than|at most|up to)\s+\$?\s*([\d,]+(?:\.\d+)?)/gi;

/**
 * "over $5,000", "more than 100 hours": a bound that applies to a numeric
 * column the question names (a unit word matching the column name, e.g.
 * "days" → overdue_days). With no named column, the bound goes to the
 * one measure of the files the question is about whose RANGE contains the
 * bound — "over 5,000" cannot mean a percentage column that tops out at 20.
 * Several candidates, or none: the bound is left to the model.
 */
export function matchThresholds(question: string, datasets: RagDataset[], columns: ColumnMatch[], relevant: Set<string>, cells: CellMatch[]): ThresholdMatch[] {
  const out: ThresholdMatch[] = [];
  const inRange = (c: ColumnSchema, value: number) => typeof c.min === "number" && typeof c.max === "number" && c.min <= value && value <= c.max;
  for (const m of question.matchAll(THRESHOLD)) {
    const word = m[1].toLowerCase();
    const value = Number(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const op: ThresholdMatch["op"] = /^(at least)$/.test(word) ? ">=" : /^(at most|up to)$/.test(word) ? "<=" : /^(below|under|less than|fewer than)$/.test(word) ? "<" : ">";
    const named = columns.filter((c) => !c.isKey && datasets.find((d) => d.id === c.datasetId)?.columns.find((x) => x.name === c.column)?.type === "number");
    let targets: { datasetId: string; datasetName: string; column: string }[] = named;
    if (targets.length === 0) {
      // Files with a direct value match first (the bound qualifies THOSE rows), else every relevant file.
      const direct = new Set(cells.map((c) => c.datasetId));
      const pool = datasets.filter((d) => (direct.size ? direct.has(d.id) : relevant.has(d.id)));
      const cands = pool.flatMap((d) => measureColumns(d).filter((c) => inRange(c, value)).map((c) => ({ datasetId: d.id, datasetName: d.name, column: c.name })));
      if (cands.length === 1) targets = cands;
    }
    for (const t of targets) out.push({ ...t, op, value });
  }
  return out;
}

function passesThreshold(v: unknown, t: ThresholdMatch): boolean {
  if (typeof v !== "number") return false;
  return t.op === ">" ? v > t.value : t.op === ">=" ? v >= t.value : t.op === "<" ? v < t.value : v <= t.value;
}

/**
 * Turns the cell and date matches into row subsets and computes exact facts
 * about them. Within one file: values of the same column are OR-ed, different
 * columns AND-ed. A file with no direct match but linked by a key to a file
 * that has one receives that filter through the key (one hop): the member
 * rows matching "Lisbon" select the loan rows of those members.
 */
export function computeSubsets(datasets: RagDataset[], links: DatasetLink[], cells: CellMatch[], dates: DateMatch[], relevant?: Set<string>, thresholds: ThresholdMatch[] = []): SubsetFacts[] {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const direct = new Map<string, { rows: Set<number>; filters: string[] }>();

  for (const ds of datasets) {
    const myCells = cells.filter((m) => m.datasetId === ds.id);
    const myDate = dates.find((m) => m.datasetId === ds.id);
    const myThresholds = thresholds.filter((t) => t.datasetId === ds.id);
    if (myCells.length === 0 && !myDate && myThresholds.length === 0) continue;
    const byColumn = new Map<string, Set<string>>();
    for (const m of myCells) {
      if (!byColumn.has(m.column)) byColumn.set(m.column, new Set());
      byColumn.get(m.column)!.add(phraseNorm(m.value));
    }
    const filters: string[] = [];
    for (const [col, vals] of byColumn) filters.push(`${col} is ${Array.from(vals).map((v) => `"${myCells.find((m) => phraseNorm(m.value) === v)!.value}"`).join(" or ")}`);
    if (myDate) filters.push(`${myDate.column} in ${myDate.month ? MONTHS[myDate.month - 1] + " " : ""}${myDate.year ?? "any year"}`);
    for (const t of myThresholds) filters.push(`${t.column} ${t.op} ${fmt(t.value)}`);
    const rows = new Set<number>();
    ds.rows.forEach((r, i) => {
      for (const [col, vals] of byColumn) { const v = r[col]; if (v === null || v === undefined || !vals.has(phraseNorm(String(v)))) return; }
      if (myDate && !inPeriod(r[myDate.column], myDate.year, myDate.month)) return;
      for (const t of myThresholds) if (!passesThreshold(r[t.column], t)) return;
      rows.add(i);
    });
    direct.set(ds.id, { rows, filters });
  }

  // One-hop propagation through key links, from each file with a direct
  // match into every RELEVANT linked file. A file with its own direct match
  // is narrowed further (AND): "members in Lisbon with a premium membership"
  // narrows the Lisbon members to those holding a premium membership.
  const propagated = new Map<string, { rows: Set<number>; from: string[]; filters: string[] }>();
  for (const l of links) {
    for (const [srcId, dstId, srcCol, dstCol] of [[l.datasetIdA, l.datasetIdB, l.columnA, l.columnB], [l.datasetIdB, l.datasetIdA, l.columnB, l.columnA]] as const) {
      const src = direct.get(srcId);
      const srcDs = byId.get(srcId), dstDs = byId.get(dstId);
      if (!src || !srcDs || !dstDs) continue;
      if (relevant && !relevant.has(dstId)) continue;
      const keys = new Set<string>();
      for (const i of src.rows) { const k = normalizeKey(srcDs.rows[i][srcCol]); if (k) keys.add(k); }
      const hit = new Set<number>();
      dstDs.rows.forEach((r, i) => { const k = normalizeKey(r[dstCol]); if (k && keys.has(k)) hit.add(i); });
      const existing = propagated.get(dstId);
      if (existing) {
        // Two incoming propagations: AND them.
        for (const i of Array.from(existing.rows)) if (!hit.has(i)) existing.rows.delete(i);
        existing.from.push(srcDs.name);
        existing.filters.push(`${dstCol} matches ${srcDs.name} rows where ${src.filters.join(" and ")}`);
      } else {
        propagated.set(dstId, { rows: hit, from: [srcDs.name], filters: [`${dstCol} matches ${srcDs.name} rows where ${src.filters.join(" and ")}`] });
      }
    }
  }

  const out: SubsetFacts[] = [];
  for (const ds of datasets) {
    const d = direct.get(ds.id), p = propagated.get(ds.id);
    if (!d && !p) continue;
    const chosen = d && p ? new Set(Array.from(d.rows).filter((i) => p.rows.has(i))) : d ? d.rows : p!.rows;
    const rowIdx = Array.from(chosen).sort((a, b) => a - b);
    const rows = rowIdx.map((i) => ds.rows[i]);
    const numeric = ds.columns
      .filter((c) => c.type === "number" && !c.isUnique && !isKeyName(c.name))
      .map((c) => numericStats(rows, c.name))
      .filter((x): x is NumericStats => x !== null);
    const blanks = ds.columns
      .map((c) => ({ column: c.name, blank: rows.filter((r) => r[c.name] === null || r[c.name] === undefined || r[c.name] === "").length }))
      .filter((b) => b.blank > 0);
    const idCol = nearUniqueId(ds);
    const distinctIds = idCol ? { column: idCol.name, n: new Set(rows.map((r) => normalizeKey(r[idCol.name])).filter(Boolean)).size } : undefined;
    const breakdowns = ds.columns
      .filter((c) => isCategorical(c) && (c.distinctCount ?? Infinity) <= BREAKDOWN_MAX_VALUES)
      .map((c) => {
        const counts = new Map<string, number>();
        for (const r of rows) { const v = fmt(r[c.name]); counts.set(v, (counts.get(v) ?? 0) + 1); }
        return { column: c.name, counts: Array.from(counts, ([value, n]) => ({ value, rows: n })).sort((a, b) => b.rows - a.rows) };
      })
      .filter((b) => b.counts.length > 1);
    out.push({
      datasetId: ds.id, datasetName: ds.name,
      filters: [...(d?.filters ?? []), ...(p?.filters ?? [])],
      propagatedFrom: p?.from ?? [],
      rows: rows.length, total: ds.rowCount, numeric, breakdowns, blanks, distinctIds, rowIndexes: rowIdx,
    });
  }
  return out;
}

// ─── Computation: "by <dimension>" breakdowns, within and across files ─────

/**
 * For a categorical column the question names, one group per value with
 * the row count and the sum/mean/median of every measure — computed in the
 * dimension's own file, and in every relevant file linked to it by a key
 * (the loan file grouped by the member's city). A key column the
 * question names (an account-manager id) is a dimension too; the label of
 * the row it points at is looked up so the model can name it.
 */
export function computeBreakdowns(datasets: RagDataset[], links: DatasetLink[], columns: ColumnMatch[], relevant: Set<string>, subsets: SubsetFacts[], cells: CellMatch[] = []): Breakdown[] {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const subsetRows = new Map(subsets.map((s) => [s.datasetId, new Set(s.rowIndexes)]));
  const out: Breakdown[] = [];
  const seen = new Set<string>();

  const labelFor = (ds: RagDataset, column: string): ((v: unknown) => string) =>
    isKeyName(column) ? keyLabeller(datasets, links, ds, column) : (v) => fmt(v);

  const groupRows = (measureDs: RagDataset, rows: Record<string, unknown>[], keysOf: (r: Record<string, unknown>) => string[] | null, label: (v: unknown) => string) => {
    const groups = new Map<string, Record<string, unknown>[]>();
    let unmatched = 0, multiValued = false;
    for (const r of rows) {
      const ks = keysOf(r);
      if (ks === null || ks.length === 0) { unmatched++; continue; }
      if (ks.length > 1) multiValued = true;
      for (const k of ks) { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    }
    const measures = measureColumns(measureDs);
    // A second dimension: a categorical column of the measure file that the question named a value of.
    const splitCol = measureDs.columns.find((c) => isCategorical(c) && (c.distinctCount ?? Infinity) <= BREAKDOWN_MAX_VALUES && cells.some((m) => m.datasetId === measureDs.id && m.column === c.name));
    const idCol = nearUniqueId(measureDs);
    const result = Array.from(groups, ([value, rs]) => {
      const counts = new Map<string, number>();
      if (splitCol) for (const r of rs) { const v = fmt(r[splitCol.name]); counts.set(v, (counts.get(v) ?? 0) + 1); }
      const ids = idCol ? new Set(rs.map((r) => normalizeKey(r[idCol.name])).filter(Boolean)).size : undefined;
      return {
        value: label(value),
        rows: rs.length,
        ...(idCol && ids !== undefined ? { distinctIds: { column: idCol.name, n: ids } } : {}),
        stats: measures.map((m) => numericStats(rs, m.name)).filter((x): x is NumericStats => x !== null),
        ...(splitCol ? { split: { column: splitCol.name, counts: Array.from(counts, ([v, n]) => ({ value: v, rows: n })).sort((a, b) => b.rows - a.rows) } } : {}),
      };
    }).sort((a, b) => b.rows - a.rows);
    return { measures: measures.map((m) => m.name), groups: result, unmatchedRows: unmatched, multiValued };
  };

  for (const cm of columns) {
    const dimDs = byId.get(cm.datasetId);
    const dimCol = dimDs?.columns.find((c) => c.name === cm.column);
    if (!dimDs || !dimCol) continue;
    const distinct = dimCol.distinctCount ?? Infinity;
    const usable = (dimCol.type === "string" || dimCol.type === "boolean") && !dimCol.isUnique && distinct <= NAMED_DIMENSION_MAX_VALUES;
    if (!usable) continue;
    const label = labelFor(dimDs, dimCol.name);

    // In the dimension's own file (within the subset, when one exists).
    const ownRows = subsetRows.has(dimDs.id) ? dimDs.rows.filter((_, i) => subsetRows.get(dimDs.id)!.has(i)) : dimDs.rows;
    const ownKey = `${dimDs.id}|${dimCol.name}|${dimDs.id}`;
    if (!seen.has(ownKey)) {
      seen.add(ownKey);
      const g = groupRows(dimDs, ownRows, (r) => { const v = r[dimCol.name]; return [v === null || v === undefined || v === "" ? "(blank)" : String(v)]; }, label);
      out.push({ dimensionDataset: dimDs.name, dimension: dimCol.name, measureDataset: dimDs.name, ...g });
    }

    // In each relevant file linked by a key: look the dimension value up through the key.
    for (const l of links) {
      for (const [aId, aCol, bId, bCol] of [[l.datasetIdA, l.columnA, l.datasetIdB, l.columnB], [l.datasetIdB, l.columnB, l.datasetIdA, l.columnA]] as const) {
        if (aId !== dimDs.id) continue;
        const measureDs = byId.get(bId);
        if (!measureDs || !relevant.has(bId) || bId === aId) continue;
        const key = `${dimDs.id}|${dimCol.name}|${bId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Every distinct dimension value behind a key, so a measure row whose
        // key has several (a member with two memberships) counts under each.
        const dimRowsInScope = subsetRows.has(dimDs.id) ? dimDs.rows.filter((_, i) => subsetRows.get(dimDs.id)!.has(i)) : dimDs.rows;
        const lookup = new Map<string, Set<string>>();
        for (const r of dimRowsInScope) { const k = normalizeKey(r[aCol]); if (!k) continue; const v = r[dimCol.name]; if (!lookup.has(k)) lookup.set(k, new Set()); lookup.get(k)!.add(v === null || v === undefined || v === "" ? "(blank)" : String(v)); }
        const mRows = subsetRows.has(bId) ? measureDs.rows.filter((_, i) => subsetRows.get(bId)!.has(i)) : measureDs.rows;
        const g = groupRows(measureDs, mRows, (r) => { const k = normalizeKey(r[bCol]); const vs = k ? lookup.get(k) : undefined; return vs ? Array.from(vs) : null; }, label);
        out.push({ dimensionDataset: dimDs.name, dimension: dimCol.name, measureDataset: measureDs.name, via: `${measureDs.name}.${bCol} → ${dimDs.name}.${aCol}`, ...g });
      }
    }
  }
  return out;
}

// ─── Computation: rows with no partner across a key link ───────────────────

/**
 * For every key link between the files, how many rows on each side have no
 * match on the other — the exact answer to "which X have no Y", which no
 * amount of row retrieval can produce.
 */
export function computeAntiJoins(datasets: RagDataset[], links: DatasetLink[]): AntiJoinFact[] {
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const out: AntiJoinFact[] = [];
  for (const l of links) {
    const a = byId.get(l.datasetIdA), b = byId.get(l.datasetIdB);
    if (!a || !b) continue;
    for (const [src, srcCol, dst, dstCol] of [[a, l.columnA, b, l.columnB], [b, l.columnB, a, l.columnA]] as const) {
      const dstKeys = new Set<string>();
      for (const r of dst.rows) { const k = normalizeKey(r[dstCol]); if (k) dstKeys.add(k); }
      const label = keyLabeller(datasets, links, src, srcCol);
      const missing = new Map<string, string>();
      for (const r of src.rows) { const k = normalizeKey(r[srcCol]); if (k && !dstKeys.has(k) && !missing.has(k)) missing.set(k, label(r[srcCol])); }
      out.push({ datasetName: src.name, column: srcCol, otherDataset: dst.name, otherColumn: dstCol, unmatched: missing.size, total: src.rowCount, keys: missing.size <= ANTI_JOIN_MAX_KEYS ? Array.from(missing.values()) : [] });
    }
  }
  return out;
}

// ─── Row retrieval: BM25 over row text, within a subset when one exists ────

function rowText(row: Record<string, unknown>, columns: ColumnSchema[]): string {
  return columns.map((c) => { const v = row[c.name]; return v === null || v === undefined ? "" : String(v); }).join(" ");
}

export function retrieveRows(question: string, datasets: RagDataset[], maxRows = MAX_ROWS, restrictTo?: Map<string, Set<number>>): { rows: RetrievedRow[]; terms: string[] } {
  const terms = queryTerms(question);
  if (terms.length === 0) return { rows: [], terms };

  const docs: { ds: RagDataset; index: number; tf: Map<string, number>; len: number }[] = [];
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const ds of datasets) {
    const allowed = restrictTo?.get(ds.id);
    for (let i = 0; i < ds.rows.length; i++) {
      if (allowed && !allowed.has(i)) continue;
      const toks = tokenize(rowText(ds.rows[i], ds.columns));
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of terms) if (tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
      docs.push({ ds, index: i, tf, len: toks.length });
      totalLen += toks.length;
    }
  }
  const N = docs.length;
  if (N === 0) return { rows: [], terms };
  const avgLen = totalLen / N;

  const scored: RetrievedRow[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgLen)));
    }
    if (score > 0) scored.push({ datasetId: d.ds.id, datasetName: d.ds.name, index: d.index, score, row: d.ds.rows[d.index] });
  }
  scored.sort((a, b) => b.score - a.score || a.datasetName.localeCompare(b.datasetName) || a.index - b.index);
  return { rows: scored.slice(0, maxRows), terms };
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function columnStats(ds: RagDataset, c: ColumnSchema): string {
  const parts: string[] = [c.type];
  if (c.type === "number") {
    const st = !isKeyName(c.name) && !c.isUnique ? numericStats(ds.rows, c.name) : null;
    if (st) parts.push(`n=${st.n}`, `sum=${fmt(st.sum)}`, `mean=${fmt(st.mean)}`, `median=${fmt(st.median)}`);
    if (typeof c.min === "number" && typeof c.max === "number") parts.push(`min=${fmt(c.min)}`, `max=${fmt(c.max)}`);
  } else if (c.type === "date" && c.min && c.max) {
    parts.push(`from ${c.min} to ${c.max}`);
  }
  if (typeof c.distinctCount === "number") parts.push(`${c.distinctCount} distinct`);
  if (c.isUnique) parts.push("unique per row");
  if (c.distinctValues?.length) parts.push(`values: ${c.distinctValues.join(" | ")}`);
  else if (c.sample.length) parts.push(`e.g. ${c.sample.slice(0, 3).join(" | ")}`);
  if ((c.nullCount ?? 0) > 0) parts.push(`${c.nullCount} blank`);
  return parts.join(", ");
}

/** One row as a key-value line — the format models read most accurately. */
function kvRow(ds: RagDataset, index: number, row: Record<string, unknown>): string {
  return `- ${ds.name} row ${index + 1}: ${ds.columns.map((c) => `${c.name}=${fmt(row[c.name])}`).join("; ")}`;
}

/**
 * Builds the context the model reads, most reliable information first:
 * 1. schema + whole-file statistics per file;
 * 2. exact facts computed for the subsets the question's phrases select;
 * 3. the rows of those subsets (all, when few), else the best-matching rows.
 */
export function buildRagContext(question: string, datasets: RagDataset[], links: DatasetLink[] = []): RagContext {
  const terms = queryTerms(question);
  const cellMatches = matchCells(question, datasets);
  // A word that named a VALUE ("North" in "North Wing") has been
  // accounted for; it must not also pull in a file or column of that name.
  const consumed = new Set(cellMatches.flatMap((m) => tokenize(m.value)));
  const freeTerms = terms.filter((t) => !consumed.has(t));
  const matchedColumns = matchColumns(freeTerms, datasets);
  const relevant = relevantDatasets(freeTerms, datasets, cellMatches, matchedColumns);
  const dateMatches = matchDates(question, datasets, relevant);
  const thresholds = matchThresholds(question, datasets, matchedColumns, relevant, cellMatches);
  const subsets = computeSubsets(datasets, links, cellMatches, dateMatches, relevant, thresholds);
  const breakdowns = computeBreakdowns(datasets, links, matchedColumns, relevant, subsets, cellMatches);
  const antiJoins = computeAntiJoins(datasets, links);

  const restrict = subsets.length ? new Map(subsets.map((s) => [s.datasetId, new Set(s.rowIndexes)])) : undefined;
  let { rows: retrieved } = retrieveRows(question, datasets, MAX_ROWS, restrict);
  // Terms that only matched cells/columns leave row scores at zero; fall back to the whole data.
  if (retrieved.length === 0 && restrict) retrieved = retrieveRows(question, datasets, MAX_ROWS).rows;
  const sampledOnly = retrieved.length === 0 && cellMatches.length === 0 && matchedColumns.length === 0 && subsets.length === 0 && breakdowns.length === 0;

  const lines: string[] = [];
  lines.push("## Files, columns and whole-file statistics");
  for (const ds of datasets) {
    const dupId = nearUniqueId(ds);
    lines.push(`### ${ds.name} (${ds.rowCount.toLocaleString("en-US")} rows${dupId ? `; ${dupId.name} has ${dupId.distinctCount!.toLocaleString("en-US")} distinct values, so ${(ds.rowCount - dupId.distinctCount!).toLocaleString("en-US")} row(s) repeat an existing ${dupId.name} — count distinct ${dupId.name} for "how many"` : ""})`);
    for (const n of ds.notes ?? []) lines.push(`Note: ${n}`);
    for (const c of ds.columns) lines.push(`- ${c.name}: ${columnStats(ds, c)}`);
    lines.push("");
  }
  if (links.length) {
    const nameOf = (id: string) => datasets.find((d) => d.id === id)?.name ?? id;
    const shown = links.filter((l) => datasets.some((d) => d.id === l.datasetIdA) && datasets.some((d) => d.id === l.datasetIdB));
    if (shown.length) {
      lines.push("## Key links between files (rows can be matched on these)");
      for (const l of shown) lines.push(`- ${nameOf(l.datasetIdA)}.${l.columnA} ↔ ${nameOf(l.datasetIdB)}.${l.columnB}${l.cardinality ? ` (${l.cardinality})` : ""}`);
      lines.push("");
    }
  }

  if (matchedColumns.length || cellMatches.length || dateMatches.length || thresholds.length) {
    lines.push("## What the question's words matched in the data");
    for (const m of matchedColumns) lines.push(`- column ${m.datasetName}.${m.column}`);
    for (const m of cellMatches) lines.push(`- value "${m.value}" in ${m.datasetName}.${m.column} (${m.rowsWithValue.toLocaleString("en-US")} rows)`);
    for (const m of dateMatches) lines.push(`- period ${m.month ? MONTHS[m.month - 1] + " " : ""}${m.year ?? ""} in ${m.datasetName}.${m.column} (${m.rows.toLocaleString("en-US")} rows)`);
    for (const t of thresholds) lines.push(`- bound ${t.datasetName}.${t.column} ${t.op} ${fmt(t.value)}`);
    lines.push("");
  }

  if (antiJoins.length) {
    lines.push("## Rows with no partner across a key link (exact)");
    for (const a of antiJoins) lines.push(`- ${a.datasetName}: ${a.unmatched.toLocaleString("en-US")} of ${a.total.toLocaleString("en-US")} rows have a ${a.column} with no match in ${a.otherDataset}.${a.otherColumn}${a.keys.length ? ` — ${a.keys.join(", ")}` : ""}`);
    lines.push("");
  }

  if (breakdowns.length) {
    lines.push("## Exact breakdowns by the dimension the question names (computed over the full data)");
    for (const b of breakdowns) {
      const scope = subsets.find((s) => s.datasetName === b.measureDataset);
      lines.push(`### ${b.measureDataset} rows${scope ? ` (only those where ${scope.filters.join(" AND ")})` : ""} by ${b.dimensionDataset}.${b.dimension}${b.via ? ` (via ${b.via})` : ""}`);
      for (const g of b.groups) lines.push(`- ${g.value}: rows=${g.rows.toLocaleString("en-US")}${g.distinctIds ? ` (${g.distinctIds.n.toLocaleString("en-US")} distinct ${g.distinctIds.column})` : ""}${g.split ? ` (${g.split.column}: ${g.split.counts.map((c) => `${c.value}=${c.rows}`).join(", ")})` : ""}${g.stats.map((st) => `; ${st.column} sum=${fmt(st.sum)} mean=${fmt(st.mean)} median=${fmt(st.median)}`).join("")}`);
      if (b.unmatchedRows) lines.push(`- (no ${b.dimension} found for ${b.unmatchedRows.toLocaleString("en-US")} rows)`);
      if (b.multiValued) lines.push(`- (a ${b.measureDataset} row linked to several ${b.dimension} values is counted under each, so the groups can add up to more than the row total)`);
    }
    lines.push("");
  }

  if (subsets.length) {
    lines.push("## Exact facts computed for the matching rows (computed over the full data — use these numbers as they are)");
    for (const s of subsets) {
      lines.push(`### ${s.datasetName}: ${s.rows.toLocaleString("en-US")} of ${s.total.toLocaleString("en-US")} rows${s.distinctIds ? ` (${s.distinctIds.n.toLocaleString("en-US")} distinct ${s.distinctIds.column})` : ""} where ${s.filters.join(" AND ")}${s.propagatedFrom.length ? ` (selected through the key link from ${s.propagatedFrom.join(", ")})` : ""}`);
      for (const n of s.numeric) lines.push(`- ${n.column}: n=${n.n}, sum=${fmt(n.sum)}, mean=${fmt(n.mean)}, median=${fmt(n.median)}, min=${fmt(n.min)}, max=${fmt(n.max)}`);
      for (const b of s.breakdowns) lines.push(`- by ${b.column}: ${b.counts.map((c) => `${c.value}=${c.rows}`).join(", ")}`);
      for (const b of s.blanks) lines.push(`- ${b.column}: blank in ${b.blank} of these ${s.rows} rows`);
    }
    lines.push("");
  }

  let used = lines.join("\n").length;
  const shownRows: RetrievedRow[] = [];
  const push = (line: string) => { if (used + line.length + 1 > MAX_CONTEXT_CHARS) return false; lines.push(line); used += line.length + 1; return true; };

  // Rows of small subsets in full, so a "which/list" question is answered completely.
  const listed = new Set<string>();
  for (const s of subsets) {
    if (s.rows === 0 || s.rows > MAX_SUBSET_ROWS_SHOWN) continue;
    const ds = datasets.find((d) => d.id === s.datasetId)!;
    if (!push(`## All ${s.rows} matching rows of ${s.datasetName}`)) break;
    for (const i of s.rowIndexes) {
      if (!push(kvRow(ds, i, ds.rows[i]))) break;
      listed.add(`${ds.id}:${i}`);
      shownRows.push({ datasetId: ds.id, datasetName: ds.name, index: i, score: 0, row: ds.rows[i] });
    }
    push("");
  }

  const candidates: RetrievedRow[] = sampledOnly
    ? datasets.flatMap((ds) => ds.rows.slice(0, HEAD_SAMPLE_PER_FILE).map((row, index) => ({ datasetId: ds.id, datasetName: ds.name, index, score: 0, row })))
    : retrieved.filter((r) => !listed.has(`${r.datasetId}:${r.index}`));
  if (candidates.length) {
    push(sampledOnly
      ? `## Sample rows (nothing in the data matched the question's words — first ${HEAD_SAMPLE_PER_FILE} rows of each file, a sample only)`
      : `## Rows that best match the question's words (${terms.join(", ")}) — a selection, not the whole data`);
    for (const r of candidates) {
      const ds = datasets.find((d) => d.id === r.datasetId)!;
      if (!push(kvRow(ds, r.index, r.row))) break;
      shownRows.push(r);
    }
  }

  const coverage = datasets.map((ds) => ({
    datasetName: ds.name,
    retrieved: shownRows.filter((r) => r.datasetId === ds.id).length,
    total: ds.rowCount,
    matchedColumns: matchedColumns.filter((m) => m.datasetId === ds.id).map((m) => m.column),
  }));

  const text = lines.join("\n");
  return { text, retrieved: shownRows, cellMatches, dateMatches, subsets, breakdowns, antiJoins, thresholds, matchedColumns, coverage, sampledOnly, queryTerms: terms, chars: text.length };
}

// ─── Groundedness: are the answer's numbers in the context? ────────────────

function numberForms(n: number): string[] {
  const forms = new Set<string>();
  for (const v of [n, Math.round(n), Math.round(n * 100) / 100, Math.round(n * 10) / 10]) {
    forms.add(String(v)); forms.add(v.toLocaleString("en-US")); forms.add(v.toFixed(2)); forms.add(v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  }
  return Array.from(forms);
}

/**
 * A cheap faithfulness check: every number the model wrote should appear
 * in the context it was given (as a statistic, a computed fact or a cell),
 * allowing rounding. A number that appears nowhere was either computed by
 * the model — possible, error-prone — or invented.
 */
export function checkGroundedness(answerText: string, tableCells: unknown[], context: string): { total: number; grounded: number; missing: string[] } {
  const ctx = context.replace(/,/g, "");
  const ctxNums = new Set((ctx.match(/-?\d+(?:\.\d+)?/g) ?? []).map((s) => String(Number(s))));
  const has = (n: number) => numberForms(n).some((f) => ctxNums.has(String(Number(f.replace(/,/g, "")))) || context.includes(f));
  const candidates = new Set<string>();
  for (const m of answerText.replace(/(\d),(\d)/g, "$1$2").match(/-?\d+(?:\.\d+)?/g) ?? []) candidates.add(m);
  for (const c of tableCells) if (typeof c === "number") candidates.add(String(c)); else if (typeof c === "string" && /^-?\d+(?:\.\d+)?$/.test(c.replace(/,/g, ""))) candidates.add(c.replace(/,/g, ""));
  const numbers = Array.from(candidates).map(Number).filter((n) => Number.isFinite(n) && Math.abs(n) >= 10 && !(n >= 1900 && n <= 2100 && Number.isInteger(n)));
  const missing = numbers.filter((n) => !has(n)).map((n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  return { total: numbers.length, grounded: numbers.length - missing.length, missing };
}
