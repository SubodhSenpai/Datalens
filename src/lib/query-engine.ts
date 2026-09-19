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
}

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
  for (const row of otherRows) {
    const key = normalizeKey(row[rightKey]);
    if (key === null) continue;
    const bucket = index.get(key);
    if (bucket) bucket.push(row); else index.set(key, [row]);
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
  }
  return out;
}

export function computePearsonCorrelation(
  rows: Record<string, unknown>[],
  columnX: string,
  columnY: string
): { coefficient: number; sampleSize: number } | null {
  const pairs = rows
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

function interpretCorrelation(r: number): string {
  const abs = Math.abs(r);
  const strength = abs >= 0.7 ? "strong" : abs >= 0.4 ? "moderate" : abs >= 0.2 ? "weak" : "negligible";
  const direction = r > 0.001 ? "positive" : r < -0.001 ? "negative" : "no";
  return direction === "no" ? "no meaningful correlation" : `${strength} ${direction} correlation`;
}

// ─── Derived (computed) columns ────────────────────────────────────────────
//
// Real questions often need a value that isn't a literal column ("revenue"
// = quantity x unit_price x (1 - discount_pct/100), "profit" = revenue -
// qty x cost_price). Rather than teach the planner to precompute these in
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
  if (plan.derive?.length) working = applyDerive(working, plan.derive, warnings);
  const availableColumns = working.length > 0 ? Object.keys(working[0]) : [];

  if (plan.filters?.length) {
    for (const f of plan.filters) {
      if (!availableColumns.includes(f.column)) {
        warnings.push(`Ignored filter on unknown column "${f.column}".`);
        continue;
      }
      working = working.filter((row) => applyFilter(row[f.column], f));
    }
  }

  let correlation: ExecutionResult["correlation"];
  if (plan.correlate) {
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
    resultRows = Object.entries(grouped).map(([, groupRows]) => {
      const out: Record<string, unknown> = {};
      groupCols.forEach((c) => { out[c] = groupRows[0][c]; });
      for (const agg of aggs) {
        out[agg.as ?? `${agg.fn}_${agg.column}`] = computeAggregate(groupRows, agg);
      }
      if (aggs.length === 0) out["count"] = groupRows.length;
      return out;
    });

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
        resultRows = resultRows.filter((row) => applyFilter(row[h.column], h));
      }
    }

    resultColumns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [...groupCols];
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
  if (cellValue === null || cellValue === undefined) return op === "neq";

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

function computeAggregate(rows: Record<string, unknown>[], agg: QueryAggregation): number {
  if (agg.fn === "count") return rows.length;
  // Distinct count works on ANY column type (it's the only aggregate that
  // means something over strings), and is what "how many employees" wants
  // when a table has several rows per employee — plain count would report
  // the row count instead.
  if (agg.fn === "countDistinct") {
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r[agg.column];
      if (v !== null && v !== undefined && v !== "") seen.add(String(v));
    }
    return seen.size;
  }
  const nums = rows.map((r) => Number(r[agg.column])).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return 0;
  switch (agg.fn) {
    case "sum": return round(nums.reduce((a, b) => a + b, 0));
    case "avg": return round(nums.reduce((a, b) => a + b, 0) / nums.length);
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
