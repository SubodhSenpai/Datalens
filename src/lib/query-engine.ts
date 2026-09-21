import { QueryPlan, QueryFilter, QueryAggregation, QueryDateBucket, QueryDerivedColumn } from "./types";
import { normalizeKey } from "./keys";

export interface ExecutionResult {
  columns: string[];
  rows: Record<string, unknown>[];
  warnings: string[];
  correlation?: {
    columnX: string;
    columnY: string;
    coefficient: number;
    sampleSize: number;
    interpretation: string;
  };
}

export class JoinKeyMissingError extends Error {
  constructor(public readonly column: string, public readonly side: "base" | "joined") {
    super(`Join key "${column}" does not exist in the ${side} dataset.`);
    this.name = "JoinKeyMissingError";
  }
}

/**
 * The prefix a joined dataset's columns receive when they collide with a
 * column already present: file extension dropped, anything that isn't a
 * letter or digit collapsed to "_". "c_refunds.csv" → "c_refunds", so its
 * colliding "amount" becomes "c_refunds_amount". Exported because the
 * validator and the planner prompt must produce exactly the same name, or a
 * correctly written plan gets rejected as referencing an unknown column.
 */
export function joinPrefix(datasetName: string): string {
  return datasetName.replace(/\.(csv|xlsx|xls)$/i, "").replace(/[^a-zA-Z0-9]+/g, "_");
}

/** What a join actually did, for the trace and for fan-out detection. */
export interface JoinStats {
  baseRows: number;
  outputRows: number;
  /** Base rows that found no match (dropped by an inner join). */
  unmatchedBaseRows: number;
  /** Most matches any single base row attracted — >1 means the join fanned out. */
  maxMatchesPerBaseRow: number;
  /**
   * Column names that existed on BOTH sides and so were renamed on the
   * joined side. The base keeps the bare name, which means a plan referring
   * to it gets the base's column — worth saying out loud.
   */
  collidedColumns: { column: string; renamedTo: string }[];
  /**
   * Joined-side rows ignored because they repeated a key that is otherwise
   * unique in that file (a duplicated record in a lookup table). Without
   * this, one duplicated record doubles every figure joined through it.
   */
  duplicateKeysDropped?: number;
}

// A joined side whose key is distinct on at least this share of its rows is
// a lookup table with a few duplicated records, not a genuine one-to-many.
const LOOKUP_UNIQUENESS = 0.9;

// Inner/left join of two row sets on (possibly differently-named) key
// columns, prefixing the joined dataset's non-key columns to avoid
// clobbering same-named columns — the JS equivalent of the "Apply
// filters/joins/aggregations" step in Figure 5. Called once per entry in
// QueryPlan.joins before the rest of the plan executes.
//
// Throws JoinKeyMissingError if the key column isn't actually present on
// either side, rather than silently treating "column absent" as a real join
// value — without this check, two datasets that are BOTH missing the given
// column would have every row's key resolve to the same "undefined" string,
// producing a full cross-join of fabricated matches instead of an error.
export function joinRows(
  baseRows: Record<string, unknown>[],
  otherRows: Record<string, unknown>[],
  joinDatasetName: string,
  leftKey: string,
  rightKey: string,
  type: "inner" | "left" = "inner",
  stats?: JoinStats
): Record<string, unknown>[] {
  if (baseRows.length > 0 && !(leftKey in baseRows[0])) throw new JoinKeyMissingError(leftKey, "base");
  if (otherRows.length > 0 && !(rightKey in otherRows[0])) throw new JoinKeyMissingError(rightKey, "joined");

  // Keys are compared through the shared normalizer, the same one
  // relationship detection uses. Comparing them raw meant a pair of files
  // whose ids differed only in case or padding was reported as joinable and
  // then matched nothing. A key that normalizes to null (blank, "N/A") is
  // not an identity and is excluded from the index entirely, so those rows
  // cannot all collapse onto one another.
  const index = new Map<string, Record<string, unknown>[]>();
  let keyed = 0;
  for (const row of otherRows) {
    const key = normalizeKey(row[rightKey]);
    if (key === null) continue;
    keyed++;
    const bucket = index.get(key);
    if (bucket) bucket.push(row); else index.set(key, [row]);
  }

  // A lookup table (one row per key) that carries a handful of duplicated
  // records would otherwise fan every matching base row out — a customer
  // listed twice makes each of its orders count twice. Keep the first row
  // per key when the key is unique on ≥90% of rows but not all; a genuinely
  // one-to-many side (well under 90%) is left intact.
  let duplicatesDropped = 0;
  if (keyed > 0 && index.size < keyed && index.size >= keyed * LOOKUP_UNIQUENESS) {
    for (const [key, bucket] of index) {
      if (bucket.length > 1) { duplicatesDropped += bucket.length - 1; index.set(key, [bucket[0]]); }
    }
  }

  const prefix = joinPrefix(joinDatasetName);

  const baseColumns = new Set(baseRows.length > 0 ? Object.keys(baseRows[0]) : []);
  const collided: { column: string; renamedTo: string }[] = [];
  for (const key of otherRows.length > 0 ? Object.keys(otherRows[0]) : []) {
    if (key !== rightKey && baseColumns.has(key)) {
      collided.push({ column: key, renamedTo: `${prefix}_${key}` });
    }
  }

  let unmatched = 0;
  let maxMatches = 0;

  const out: Record<string, unknown>[] = [];
  for (const row of baseRows) {
    const key = normalizeKey(row[leftKey]);
    const matches = key === null ? [] : index.get(key) ?? [];
    if (matches.length > maxMatches) maxMatches = matches.length;
    if (matches.length === 0) {
      unmatched++;
      if (type === "left") out.push({ ...row });
      continue;
    }
    for (const match of matches) {
      const merged: Record<string, unknown> = { ...row };
      for (const [k, value] of Object.entries(match)) {
        if (k === rightKey) continue;
        // Renaming is decided from the BASE's column set, not from whatever
        // keys this particular merged row happens to carry, so a column
        // lands under the same name on every row.
        merged[baseColumns.has(k) ? `${prefix}_${k}` : k] = value;
      }
      out.push(merged);
    }
  }

  if (stats) {
    stats.baseRows = baseRows.length;
    stats.outputRows = out.length;
    stats.unmatchedBaseRows = unmatched;
    stats.maxMatchesPerBaseRow = maxMatches;
    stats.collidedColumns = collided;
    stats.duplicateKeysDropped = duplicatesDropped;
  }
  return out;
}

export function computePearsonCorrelation(
  rows: Record<string, unknown>[],
  columnX: string,
  columnY: string
): { coefficient: number; sampleSize: number } | null {
  const pairs = rows
    .filter((r) => !isBlankCell(r[columnX]) && !isBlankCell(r[columnY]))
    .map((r): [number, number] => [Number(r[columnX]), Number(r[columnY])])
    .filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));

  const n = pairs.length;
  if (n < 2) return null;

  const meanX = pairs.reduce((a, [x]) => a + x, 0) / n;
  const meanY = pairs.reduce((a, [, y]) => a + y, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  if (denomX === 0 || denomY === 0) return { coefficient: 0, sampleSize: n };
  return { coefficient: round(numerator / Math.sqrt(denomX * denomY)), sampleSize: n };
}

export function interpretCorrelation(r: number): string {
  const abs = Math.abs(r);
  const strength = abs >= 0.7 ? "strong" : abs >= 0.4 ? "moderate" : abs >= 0.2 ? "weak" : "negligible";
  const direction = r > 0.001 ? "positive" : r < -0.001 ? "negative" : "no";
  return direction === "no" ? "no meaningful correlation" : `${strength} ${direction} correlation`;
}

// ─── Derived (computed) columns ────────────────────────────────────────────
//
// Real questions often need a value that isn't a literal column ("billed"
// = units_used x rate_per_unit x (1 + tax_pct/100), "margin" = billed -
// units_used x cost_per_unit). Rather than teach the planner to precompute these in
// its head — a small model gets the arithmetic wrong under load — it emits
// a simple expression and this compiles + evaluates it per row. The grammar
// is deliberately tiny (numbers, existing column names, + - * / and
// parens) so there's nothing here beyond arithmetic to exploit.

type Token = { type: "num" | "id" | "op" | "lparen" | "rparen"; value: string };

function tokenizeExpr(expr: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*([0-9]+\.?[0-9]*|[A-Za-z_][A-Za-z0-9_]*|[+\-*/()])\s*/g;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    if (m.index !== idx) throw new Error(`Unexpected character in expression at "${expr.slice(idx)}"`);
    idx = re.lastIndex;
    const t = m[1];
    if (/^[0-9]/.test(t)) tokens.push({ type: "num", value: t });
    else if (/^[A-Za-z_]/.test(t)) tokens.push({ type: "id", value: t });
    else if (t === "(") tokens.push({ type: "lparen", value: t });
    else if (t === ")") tokens.push({ type: "rparen", value: t });
    else tokens.push({ type: "op", value: t });
  }
  if (idx !== expr.length) throw new Error(`Unexpected character in expression at "${expr.slice(idx)}"`);
  return tokens;
}

type Evaluator = (row: Record<string, unknown>) => number;

export function compileExpression(expr: string, columnNames: Set<string>): Evaluator {
  const tokens = tokenizeExpr(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = (type?: Token["type"]) => {
    const t = tokens[pos];
    if (!t) throw new Error("Unexpected end of expression");
    if (type && t.type !== type) throw new Error(`Expected ${type} but got "${t.value}"`);
    pos++;
    return t;
  };

  function parseAdd(): Evaluator {
    let left = parseMul();
    while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
      const op = consume().value;
      const right = parseMul();
      const prevLeft = left;
      left = op === "+" ? (row) => prevLeft(row) + right(row) : (row) => prevLeft(row) - right(row);
    }
    return left;
  }
  function parseMul(): Evaluator {
    let left = parseUnary();
    while (peek()?.type === "op" && (peek().value === "*" || peek().value === "/")) {
      const op = consume().value;
      const right = parseUnary();
      const prevLeft = left;
      left = op === "*" ? (row) => prevLeft(row) * right(row) : (row) => prevLeft(row) / right(row);
    }
    return left;
  }
  function parseUnary(): Evaluator {
    if (peek()?.type === "op" && peek().value === "-") {
      consume();
      const inner = parseUnary();
      return (row) => -inner(row);
    }
    return parsePrimary();
  }
  function parsePrimary(): Evaluator {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.type === "num") { consume(); const v = Number(t.value); return () => v; }
    if (t.type === "id") {
      consume();
      if (!columnNames.has(t.value)) throw new Error(`Unknown column "${t.value}" in expression`);
      return (row) => Number(row[t.value] ?? 0);
    }
    if (t.type === "lparen") {
      consume();
      const inner = parseAdd();
      consume("rparen");
      return inner;
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  const fn = parseAdd();
  if (pos !== tokens.length) throw new Error("Unexpected trailing tokens in expression");
  return fn;
}

function applyDerive(
  rows: Record<string, unknown>[],
  derive: QueryDerivedColumn[],
  warnings: string[]
): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  let working = rows;
  const cols = new Set(Object.keys(working[0]));
  for (const d of derive) {
    try {
      const fn = compileExpression(d.expr, cols);
      working = working.map((row) => ({ ...row, [d.as]: round(fn(row)) }));
      cols.add(d.as);
    } catch (err) {
      warnings.push(`Could not compute "${d.as}" (${d.expr}): ${err instanceof Error ? err.message : "invalid expression"}.`);
    }
  }
  return working;
}

function applyDateBucket(rows: Record<string, unknown>[], bucket: QueryDateBucket): Record<string, unknown>[] {
  const asCol = bucket.as ?? `${bucket.column}_${bucket.granularity}`;
  return rows.map((row) => {
    const raw = row[bucket.column];
    const date = typeof raw === "string" ? new Date(raw) : null;
    let value = "unknown";
    if (date && !Number.isNaN(date.getTime())) {
      const iso = date.toISOString();
      value = bucket.granularity === "year" ? iso.slice(0, 4) : bucket.granularity === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
    }
    return { ...row, [asCol]: value };
  });
}

// Deterministic execution of a QueryPlan against in-memory rows — the JS
// equivalent of the "Execute query plan deterministically (Pandas)" step in
// Figure 5. Plans only ever come from the LLM planner or a heuristic
// fallback, never directly from the user, so this can trust column names
// once validated below. Joins in plan.joins must already be applied to
// `rows` by the caller (route.ts), since only it has access to the other
// datasets' row sets.
export function executeQueryPlan(rows: Record<string, unknown>[], plan: QueryPlan): ExecutionResult {
  const warnings: string[] = [];

  let working = plan.dateBucket ? applyDateBucket(rows, plan.dateBucket) : rows;
  // A derive that names an aggregate's output ("share = exceeded / total")
  // can only run once the aggregates exist; it is held back until then.
  const sourceCols = new Set(working.length > 0 ? Object.keys(working[0]) : []);
  const producedNames = new Set((plan.aggregations ?? []).map((a) => a.as ?? `${a.fn}_${a.column}`));
  const isPost = (d: QueryDerivedColumn) => {
    const ids = d.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return ids.some((id) => producedNames.has(id) && !sourceCols.has(id));
  };
  const preDerive = (plan.derive ?? []).filter((d) => !isPost(d));
  const postDerive = (plan.derive ?? []).filter(isPost);
  if (preDerive.length) working = applyDerive(working, preDerive, warnings);
  const availableColumns = working.length > 0 ? Object.keys(working[0]) : [];

  if (plan.filters?.length) {
    for (const f of plan.filters) {
      if (!availableColumns.includes(f.column)) {
        warnings.push(`Ignored filter on unknown column "${f.column}".`);
        continue;
      }
      working = working.filter((row) => (f.compareTo ? applyFilter(row[f.column], { ...f, value: row[f.compareTo!] as number | string }) : applyFilter(row[f.column], f)));
    }
  }

  let correlation: ExecutionResult["correlation"];
  // A correlation over columns the aggregation PRODUCES ("annual pay" vs
  // "average rating per person") is computed on the grouped rows below;
  // one over raw columns is computed here, before grouping.
  const wantsGroupedCorrelation = Boolean(plan.correlate && (plan.groupBy?.length || plan.aggregations?.length)
    && (!availableColumns.includes(plan.correlate.columnX) || !availableColumns.includes(plan.correlate.columnY)));
  if (plan.correlate && !wantsGroupedCorrelation) {
    const { columnX, columnY } = plan.correlate;
    if (!availableColumns.includes(columnX) || !availableColumns.includes(columnY)) {
      warnings.push(`Could not compute correlation — "${columnX}" or "${columnY}" doesn't exist.`);
    } else {
      const result = computePearsonCorrelation(working, columnX, columnY);
      if (!result) {
        warnings.push(`Could not compute correlation between "${columnX}" and "${columnY}" — not enough numeric data.`);
      } else {
        correlation = { columnX, columnY, coefficient: result.coefficient, sampleSize: result.sampleSize, interpretation: interpretCorrelation(result.coefficient) };
      }
    }
  }

  let resultRows: Record<string, unknown>[];
  let resultColumns: string[];
  const isAggregated = Boolean(plan.groupBy?.length || plan.aggregations?.length);

  if (isAggregated) {
    const groupCols = (plan.groupBy ?? []).filter((c) => availableColumns.includes(c));
    const aggs = (plan.aggregations ?? []).filter((a) => availableColumns.includes(a.column) || a.fn === "count");

    if (plan.groupBy?.length && groupCols.length === 0) {
      warnings.push("Ignored groupBy — none of the requested columns exist.");
    }

    const grouped = groupRows(working, groupCols);
    // Blanks skipped per aggregate, so the answer can say "over 1,929 rated
    // rows; 471 blank" instead of presenting an average as if every row had
    // a value.
    const skipped = new Map<string, number>();
    resultRows = Object.entries(grouped).map(([, groupRows]) => {
      const out: Record<string, unknown> = {};
      groupCols.forEach((c) => { out[c] = groupRows[0][c]; });
      for (const agg of aggs) {
        out[agg.as ?? `${agg.fn}_${agg.column}`] = computeAggregate(groupRows, agg);
        if (agg.fn !== "count" || (agg.column !== "*" && agg.column !== "")) {
          const label = `${agg.fn}(${agg.column})`;
          skipped.set(label, (skipped.get(label) ?? 0) + blankCount(groupRows, agg.column));
        }
      }
      if (aggs.length === 0) out["count"] = groupRows.length;
      return out;
    });
    for (const [label, n] of skipped) {
      if (n > 0) warnings.push(`${label}: ${n.toLocaleString("en-US")} blank cell${n === 1 ? "" : "s"} excluded (${(working.length - n).toLocaleString("en-US")} of ${working.length.toLocaleString("en-US")} rows had a value).`);
    }

    // HAVING: filter the GROUPS by their aggregate values. Runs here, after
    // aggregation, because these conditions are about the group as a whole
    // ("had 4+ in both cycles") and are meaningless per row.
    if (plan.having?.length) {
      const producedColumns = new Set(resultRows.length > 0 ? Object.keys(resultRows[0]) : []);
      for (const h of plan.having) {
        if (!producedColumns.has(h.column)) {
          warnings.push(`Ignored "having" on "${h.column}" — the grouped result has no such column.`);
          continue;
        }
        if (h.compareTo && !producedColumns.has(h.compareTo)) { warnings.push(`Ignored "having" comparing "${h.column}" with "${h.compareTo}" — the grouped result has no such column.`); continue; }
        resultRows = resultRows.filter((row) => (h.compareTo ? applyFilter(row[h.column], { ...h, value: row[h.compareTo!] as number | string }) : applyFilter(row[h.column], h)));
      }
    }

    if (postDerive.length && resultRows.length) {
      resultRows = applyDerive(resultRows, postDerive, warnings);
    }
    resultColumns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [...groupCols];

    if (plan.correlate && wantsGroupedCorrelation) {
      const { columnX, columnY } = plan.correlate;
      if (!resultColumns.includes(columnX) || !resultColumns.includes(columnY)) {
        warnings.push(`Could not compute correlation — "${columnX}" or "${columnY}" is neither a source column nor a grouped output.`);
      } else {
        const result = computePearsonCorrelation(resultRows, columnX, columnY);
        if (!result) warnings.push(`Could not compute correlation between "${columnX}" and "${columnY}" — not enough numeric data.`);
        else correlation = { columnX, columnY, coefficient: result.coefficient, sampleSize: result.sampleSize, interpretation: interpretCorrelation(result.coefficient) };
      }
    }
  } else {
    resultRows = working;
    resultColumns = availableColumns;
  }

  // "select" only makes sense against raw, non-aggregated rows — once
  // groupBy/aggregations ran, the group keys + aggregate "as" names ARE the
  // intended output shape. Applying a leftover/redundant "select" on top
  // (e.g. the model listing just the group key) would silently discard the
  // just-computed aggregate columns instead of the raw source columns it
  // was written against.
  if (plan.select?.length && !isAggregated) {
    const validSelect = plan.select.filter((c) => resultColumns.includes(c));
    if (validSelect.length > 0) {
      resultColumns = validSelect;
      resultRows = resultRows.map((r) => {
        const out: Record<string, unknown> = {};
        validSelect.forEach((c) => { out[c] = r[c]; });
        return out;
      });
    }
  }

  if (plan.sort?.length) {
    const sortable = plan.sort.filter((s) => resultColumns.includes(s.column));
    resultRows = [...resultRows].sort((a, b) => {
      for (const s of sortable) {
        const cmp = compareValues(a[s.column], b[s.column]);
        if (cmp !== 0) return s.direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (typeof plan.limit === "number" && plan.limit > 0) {
    resultRows = resultRows.slice(0, plan.limit);
  }

  return { columns: resultColumns, rows: resultRows, warnings, correlation };
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function applyFilter(cellValue: unknown, filter: QueryFilter): boolean {
  const { op, value } = filter;
  // A cell is "null" when it is absent, blank, or a placeholder for no value
  // — the same rule keys.ts uses, so a left join's unmatched rows (which
  // carry no joined columns at all) and a blank cell are treated alike.
  const isNull = cellValue === null || cellValue === undefined || normalizeKey(cellValue) === null;
  if (op === "isNull") return isNull;
  if (op === "isNotNull") return !isNull;
  // Membership is compared the way join keys are — case and padding do not
  // make "returned" a different status from "Returned".
  if (op === "in" || op === "notIn") {
    const list = (Array.isArray(value) ? value : [value]).map((v) => normalizeKey(v));
    const hit = !isNull && list.includes(normalizeKey(cellValue));
    return op === "in" ? hit : !hit;
  }
  if (cellValue === null || cellValue === undefined) return op === "neq";
  // A column-to-column comparison whose other side is blank has no answer.
  if (filter.compareTo && (value === null || value === undefined || value === "")) return false;
  // A yes/no column is loaded as true/false; a question says "Yes".
  if (typeof cellValue === "boolean" && typeof value === "string") {
    const v = value.trim().toLowerCase();
    const wanted = ["yes", "true", "1", "y", "t"].includes(v) ? true : ["no", "false", "0", "n", "f"].includes(v) ? false : undefined;
    if (wanted !== undefined) return op === "neq" ? cellValue !== wanted : op === "eq" ? cellValue === wanted : false;
  }

  if (typeof cellValue === "number" && typeof value !== "boolean") {
    const num = Number(value);
    switch (op) {
      case "eq": return cellValue === num;
      case "neq": return cellValue !== num;
      case "gt": return cellValue > num;
      case "gte": return cellValue >= num;
      case "lt": return cellValue < num;
      case "lte": return cellValue <= num;
      case "contains": return String(cellValue).includes(String(value));
    }
  }

  // Cells are stored as full ISO datetimes ("2025-03-31T00:00:00.000Z") but
  // a filter/plan often names a bare date ("2025-03-31"). Comparing those
  // as STRINGS is wrong for lte/eq: "2025-03-31T..." sorts AFTER
  // "2025-03-31" lexicographically (longer string, same prefix), so
  // `date lte "2025-03-31"` silently excludes every row ON that exact day —
  // the whole last day of a month-end range vanishes with no error. Compare
  // as real timestamps instead, treating a bare date as spanning that
  // entire day for eq/lte (inclusive) rather than its literal midnight instant.
  if (typeof cellValue === "string" && typeof value === "string" && ISO_DATETIME.test(cellValue) && (DATE_ONLY.test(value) || ISO_DATETIME.test(value))) {
    const cellTime = Date.parse(cellValue);
    const startOfDay = Date.parse(value);
    if (!Number.isNaN(cellTime) && !Number.isNaN(startOfDay)) {
      const endOfDay = DATE_ONLY.test(value) ? startOfDay + 24 * 60 * 60 * 1000 - 1 : startOfDay;
      switch (op) {
        case "eq": return cellTime >= startOfDay && cellTime <= endOfDay;
        case "neq": return !(cellTime >= startOfDay && cellTime <= endOfDay);
        case "gt": return cellTime > endOfDay;
        case "gte": return cellTime >= startOfDay;
        case "lt": return cellTime < startOfDay;
        case "lte": return cellTime <= endOfDay;
        case "contains": break; // fall through to string handling below
      }
    }
  }

  const strCell = String(cellValue).toLowerCase();
  const strVal = String(value).toLowerCase();
  switch (op) {
    case "eq": return strCell === strVal;
    case "neq": return strCell !== strVal;
    case "contains": return strCell.includes(strVal);
    case "gt": return strCell > strVal;
    case "gte": return strCell >= strVal;
    case "lt": return strCell < strVal;
    case "lte": return strCell <= strVal;
    default: return false;
  }
}

function groupRows(rows: Record<string, unknown>[], groupCols: string[]): Record<string, Record<string, unknown>[]> {
  if (groupCols.length === 0) return { all: rows };
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const row of rows) {
    const key = groupCols.map((c) => String(row[c])).join("||");
    (groups[key] ??= []).push(row);
  }
  return groups;
}

const isBlankCell = (v: unknown) => v === null || v === undefined || v === "";

/** Blank cells an aggregate over `column` would skip — reported, never silently dropped. */
function blankCount(rows: Record<string, unknown>[], column: string): number {
  let n = 0;
  for (const r of rows) if (isBlankCell(r[column])) n++;
  return n;
}

function computeAggregate(allRows: Record<string, unknown>[], agg: QueryAggregation): number | null {
  // A conditional aggregate sees only the rows meeting its own conditions.
  const rows = agg.where?.length
    ? allRows.filter((row) => agg.where!.every((f) => (f.compareTo ? applyFilter(row[f.column], { ...f, value: row[f.compareTo!] as number | string }) : applyFilter(row[f.column], f))))
    : allRows;
  // count(*) / count(row) counts rows; count(column) counts the cells that
  // hold a value — a blank is not an occurrence.
  if (agg.fn === "count") return agg.column === "*" || agg.column === "" ? rows.length : rows.length - blankCount(rows, agg.column);
  // Distinct count works on ANY column type (it's the only aggregate that
  // means something over strings), and is what "how many members" wants
  // when a table has several rows per member — plain count would report
  // the row count instead.
  if (agg.fn === "countDistinct") {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r[agg.column];
      if (v !== null && v !== undefined && v !== "") seen.add(String(v));
    }
    return seen.size;
  }
  // A blank cell is not a zero. Number(null) is 0, so without this guard a
  // column with 20% gaps averages 20% too low and its minimum reads as 0.
  const nums = rows
    .map((r) => r[agg.column])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n));
  // No values at all is "no value", not zero — a zero would enter averages
  // and correlations as a real observation.
  if (nums.length === 0) return null;
  switch (agg.fn) {
    case "sum": return round(nums.reduce((a, b) => a + b, 0));
    case "avg": return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "median": {
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    }
    case "min": return round(Math.min(...nums));
    case "max": return round(Math.max(...nums));
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
