import { ColumnSchema, FilterOp, QueryPlan } from "./types";
import { RelationshipRecord } from "./session-store";

const VALID_FILTER_OPS: FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"];

export interface ValidatorDataset {
  id: string;
  name: string;
  columns: ColumnSchema[];
}

export interface PlanRepair {
  field: string;
  detail: string;
}

export interface ValidatedPlan {
  plan: QueryPlan;
  repairs: PlanRepair[];
  /** Columns the plan is expected to produce, used to validate chart config up front. */
  predictedColumns: string[];
}

// Deterministic post-processing of an LLM-produced QueryPlan.
//
// The planner is a small open-weight model, and small models slip in
// predictable ways: naming a join key that only exists on one side,
// dropping a groupBy the question clearly asked for, pointing a chart at a
// column the plan will never produce. Each of those turns into a confidently
// wrong answer if executed as-is. Everything in this file is a rule that can
// be decided from the schema + relationships alone — no second model call,
// no guessing — so it behaves the same on every run regardless of how the
// model sampled.
export function validateAndRepairPlan(
  plan: QueryPlan,
  question: string,
  datasets: ValidatorDataset[],
  relationships: RelationshipRecord[]
): ValidatedPlan {
  const repairs: PlanRepair[] = [];
  const repaired: QueryPlan = structuredClone(plan);

  const byId = new Map(datasets.map((d) => [d.id, d]));

  // ── 0. Resolve dataset references (the planner names them, not ids) ─────
  const resolvedBase = resolveDatasetRef(repaired.datasetId, datasets);
  if (resolvedBase && resolvedBase.id !== repaired.datasetId) repaired.datasetId = resolvedBase.id;
  for (const join of repaired.joins ?? []) {
    const resolvedJoin = resolveDatasetRef(join.datasetId, datasets);
    if (resolvedJoin) join.datasetId = resolvedJoin.id;
  }

  // ── 1. Base dataset must exist ──────────────────────────────────────────
  if (!byId.has(repaired.datasetId)) {
    const fallback = pickBestDataset(question, datasets);
    if (fallback) {
      repairs.push({ field: "datasetId", detail: `Unknown base dataset "${repaired.datasetId}" → using "${fallback.name}".` });
      repaired.datasetId = fallback.id;
    }
  }

  // ── 1b. Re-base when the chosen dataset holds NOTHING the plan uses ─────
  // The strongest signal of a mis-picked base: not one column the plan
  // references exists in it. Joining the real table in (the old behavior)
  // "works" but silently rescopes the question to whatever rows the wrong
  // base happens to contain — a tiny unrelated file joined to the real fact
  // table answers the question for a handful of rows and looks entirely
  // plausible. Switching the base instead is both correct and visible.
  {
    const chosen = byId.get(repaired.datasetId);
    if (chosen) {
      const rebase = findBetterBase(repaired, chosen, datasets);
      if (rebase) {
        repairs.push({
          field: "datasetId",
          detail: `Base dataset "${chosen.name}" contains none of the columns this plan uses (${rebase.missing.join(", ")}) → re-based onto "${rebase.dataset.name}", which has them. Joining instead would have silently narrowed the answer to only the rows "${chosen.name}" happens to contain.`,
        });
        repaired.datasetId = rebase.dataset.id;
        // Any join the plan had was built around the wrong base; drop those
        // rather than carry a now-meaningless join chain forward.
        if (repaired.joins?.some((j) => j.datasetId === rebase.dataset.id)) repaired.joins = undefined;
      }
    }
  }

  const base = byId.get(repaired.datasetId);
  if (!base) return { plan: repaired, repairs, predictedColumns: [] };

  // ── 2. Joins: resolve keys against detected relationships ───────────────
  // Processed IN ORDER, with the available-column set growing after each
  // one — a third dataset often connects only through an already-joined
  // intermediate dataset, not directly to the base, so both the key lookup
  // AND the relationship search must see everything joined so far, not just
  // the original base dataset.
  const joinedDatasets: ValidatorDataset[] = [];
  const includedIds = [base.id];
  const availableColumns = [...base.columns];

  if (repaired.joins?.length) {
    const keptJoins: NonNullable<QueryPlan["joins"]> = [];
    for (const join of repaired.joins) {
      const other = byId.get(join.datasetId);
      if (!other || includedIds.includes(other.id)) {
        repairs.push({ field: "joins", detail: `Dropped a join to an unknown/already-included dataset id "${join.datasetId}".` });
        continue;
      }

      const otherCols = new Set(other.columns.map((c) => c.name));
      let leftOn = resolveColumn(join.leftOn ?? join.on, availableColumns);
      let rightOn = resolveColumn(join.rightOn ?? join.on, other.columns);

      const needsRepair = !leftOn || !rightOn || !otherCols.has(rightOn);
      if (needsRepair) {
        const rel = bestRelationshipAmong(includedIds, other.id, relationships);
        if (rel) {
          leftOn = rel.leftOn;
          rightOn = rel.rightOn;
          repairs.push({
            field: "joins",
            detail: `Join to "${other.name}" used key(s) that don't exist on both sides → repaired to ${leftOn} = ${rightOn} (detected by ${rel.basis}).`,
          });
        } else {
          repairs.push({
            field: "joins",
            detail: `Dropped join to "${other.name}" — no detected relationship connects it to any dataset already in the plan.`,
          });
          continue;
        }
      }

      keptJoins.push({ datasetId: other.id, leftOn, rightOn, type: join.type ?? "inner" });
      joinedDatasets.push(other);
      includedIds.push(other.id);
      for (const col of other.columns) {
        if (!availableColumns.some((c) => c.name === col.name)) availableColumns.push(col);
      }
    }
    repaired.joins = keptJoins.length > 0 ? keptJoins : undefined;
  }
  // ── 2b. Derived columns: resolve each identifier, drop invalid formulas ──
  // A derive expression only knows column names as literal text — repair
  // case/spacing drift the way every other field here does, and drop (with
  // a visible repair note) any formula that references a column that still
  // doesn't exist post-join rather than letting it crash at execution time.
  if (repaired.derive?.length) {
    const kept: NonNullable<QueryPlan["derive"]> = [];
    for (const d of repaired.derive) {
      const idents = Array.from(new Set(d.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []));
      let expr = d.expr;
      let ok = true;
      for (const ident of idents) {
        const resolved = resolveColumn(ident, availableColumns);
        if (!resolved) { ok = false; break; }
        const col = availableColumns.find((c) => c.name === resolved);
        if (col && col.type !== "number") { ok = false; break; }
        if (resolved !== ident) expr = expr.replace(new RegExp(`\\b${ident}\\b`, "g"), resolved);
      }
      if (!ok) {
        repairs.push({ field: "derive", detail: `Dropped derived column "${d.as}" — expression "${d.expr}" references a column that doesn't exist or isn't numeric.` });
        continue;
      }
      kept.push({ as: d.as, expr });
      // Downstream steps (filters/groupBy/aggregations/chart) can now treat
      // this alias as a real numeric column.
      availableColumns.push({ name: d.as, type: "number", nullable: false, sample: [] });
    }
    repaired.derive = kept.length > 0 ? kept : undefined;
  }

  const availableNames = availableColumns.map((c) => c.name);

  // ── 3. Normalize every column reference to a real column ────────────────
  if (repaired.dateBucket) {
    const col = resolveColumn(repaired.dateBucket.column, availableColumns);
    if (!col) {
      repairs.push({ field: "dateBucket", detail: `Dropped dateBucket on unknown column "${repaired.dateBucket.column}".` });
      repaired.dateBucket = undefined;
    } else if (col !== repaired.dateBucket.column) {
      repairs.push({ field: "dateBucket", detail: `Corrected dateBucket column "${repaired.dateBucket.column}" → "${col}".` });
      repaired.dateBucket = { ...repaired.dateBucket, column: col };
    }
  }
  const bucketAlias = repaired.dateBucket
    ? repaired.dateBucket.as ?? `${repaired.dateBucket.column}_${repaired.dateBucket.granularity}`
    : undefined;
  const groupableNames = bucketAlias ? [...availableNames, bucketAlias] : availableNames;

  if (repaired.filters?.length) {
    const kept = [];
    for (const f of repaired.filters) {
      // A small model occasionally invents an operator outside the schema
      // it was given (e.g. "in" for a multi-value list) — query-engine's
      // applyFilter has no case for it, which silently excludes every row
      // rather than erroring. Fail loud (drop + report) instead of quiet.
      if (!VALID_FILTER_OPS.includes(f.op)) {
        repairs.push({ field: "filters", detail: `Dropped filter with unsupported operator "${f.op}" on "${f.column}" (only eq/neq/gt/gte/lt/lte/contains are supported).` });
        continue;
      }
      const col = resolveColumn(f.column, availableColumns);
      if (!col) {
        repairs.push({ field: "filters", detail: `Dropped filter on unknown column "${f.column}".` });
        continue;
      }
      kept.push({ ...f, column: col });
    }

    // Two "eq" filters on the SAME column with different values are
    // contradictory under AND semantics (matches nothing) — this happens
    // when a "compare X vs Y" question gets misread as two filters instead
    // of a groupBy. Drop them and let groupBy (injected below, if missing)
    // surface every value instead.
    const eqByColumn = new Map<string, Set<string>>();
    for (const f of kept) {
      if (f.op !== "eq") continue;
      const set = eqByColumn.get(f.column) ?? new Set<string>();
      set.add(String(f.value));
      eqByColumn.set(f.column, set);
    }
    const contradictory = new Set(Array.from(eqByColumn.entries()).filter(([, v]) => v.size > 1).map(([c]) => c));
    let finalFilters = kept;
    if (contradictory.size > 0) {
      finalFilters = kept.filter((f) => !(f.op === "eq" && contradictory.has(f.column)));
      for (const c of contradictory) {
        repairs.push({ field: "filters", detail: `Dropped contradictory filters on "${c}" (matches multiple different values with AND) — grouping by it instead.` });
        if (!repaired.groupBy?.includes(c)) repaired.groupBy = [...(repaired.groupBy ?? []), c];
      }
    }
    repaired.filters = finalFilters.length > 0 ? finalFilters : undefined;
  }

  if (repaired.groupBy?.length) {
    const kept: string[] = [];
    for (const g of repaired.groupBy) {
      const col = groupableNames.includes(g) ? g : resolveColumn(g, availableColumns);
      if (!col) {
        repairs.push({ field: "groupBy", detail: `Dropped groupBy on unknown column "${g}".` });
        continue;
      }
      kept.push(col);
    }
    repaired.groupBy = kept.length > 0 ? kept : undefined;
  }

  if (repaired.aggregations?.length) {
    const kept = [];
    for (const a of repaired.aggregations) {
      if (a.fn === "count") { kept.push(a); continue; }
      let col = resolveColumn(a.column, availableColumns);
      // The aggregation target lives in a dataset the plan never joined — if
      // a relationship connects that dataset to something already in the
      // plan, pull it in rather than silently dropping the whole aggregation.
      if (!col) {
        col = autoIncludeDatasetWithColumn(
          a.column, a.fn === "countDistinct" ? undefined : "number", datasets, includedIds, relationships,
          availableColumns, joinedDatasets, repaired, repairs
        );
      }
      if (!col) {
        repairs.push({ field: "aggregations", detail: `Dropped ${a.fn} on unknown column "${a.column}".` });
        continue;
      }
      // countDistinct is the one aggregate that's meaningful over any type —
      // "how many distinct review cycles / departments / statuses".
      if (a.fn === "countDistinct") { kept.push({ ...a, column: col }); continue; }
      // sum/avg/min/max over a non-numeric column is meaningless and
      // silently evaluates to 0, which then gets presented as a real
      // figure (e.g. "avg of region").
      const type = availableColumns.find((c) => c.name === col)?.type;
      if (type !== "number") {
        repairs.push({ field: "aggregations", detail: `Dropped ${a.fn} on "${col}" — it is a ${type ?? "non-numeric"} column, so ${a.fn} has no meaning.` });
        continue;
      }
      kept.push({ ...a, column: col });
    }
    repaired.aggregations = kept.length > 0 ? kept : undefined;
  }

  if (repaired.correlate) {
    const x = resolveColumn(repaired.correlate.columnX, availableColumns);
    const y = resolveColumn(repaired.correlate.columnY, availableColumns);
    if (!x || !y) {
      repairs.push({ field: "correlate", detail: `Dropped correlation — "${repaired.correlate.columnX}" and/or "${repaired.correlate.columnY}" not available.` });
      repaired.correlate = undefined;
    } else {
      repaired.correlate = { columnX: x, columnY: y };
    }
  }

  // ── 4. Inject a groupBy the question asked for but the plan dropped ─────
  // "…by region", "…per channel", "…for each country" with an aggregation
  // but no groupBy silently collapses everything into one row.
  if (repaired.aggregations?.length && !repaired.groupBy?.length) {
    let implied = impliedGroupByColumn(question, availableColumns, bucketAlias);
    if (!implied) {
      // The dimension the question wants to group by lives in a dataset the
      // plan never joined at all (only an intermediate dataset got joined).
      const match = question.match(GROUP_BY_PHRASE);
      const phrase = match?.[1]?.toLowerCase().trim().split(/\s+/)[0];
      if (phrase) {
        implied = autoIncludeDatasetWithColumn(
          phrase, undefined, datasets, includedIds, relationships,
          availableColumns, joinedDatasets, repaired, repairs
        );
      }
    }
    if (implied) {
      repaired.groupBy = [implied];
      repairs.push({ field: "groupBy", detail: `Question asks for a breakdown but the plan had none → grouped by "${implied}".` });
    }
  }

  // A time-series question ("monthly revenue", "trend over time") needs a
  // bucketed date dimension. Phrased that way there's no "by <column>" for
  // the rule above to catch, so an aggregation with no time dimension
  // silently answers a 12-month question with one lifetime total.
  const granularity = impliedTimeGranularity(question);
  if (granularity && repaired.aggregations?.length && !repaired.groupBy?.length && !repaired.dateBucket) {
    const dateCol = availableColumns.find((c) => c.type === "date");
    if (dateCol) {
      const alias = `${dateCol.name}_${granularity}`;
      repaired.dateBucket = { column: dateCol.name, granularity, as: alias };
      repaired.groupBy = [alias];
      repaired.sort = [{ column: alias, direction: "asc" }];
      repairs.push({
        field: "dateBucket",
        detail: `Question asks for a ${granularity}ly breakdown but the plan had no time dimension → bucketed "${dateCol.name}" by ${granularity}.`,
      });
    }
  }

  // ── 4b. Drop joins nothing in the final plan actually uses ──────────────
  // A join whose dataset connects to another one in the plan by a real
  // relationship can still be UNNECESSARY for this specific question — e.g.
  // two sheets of the same workbook that share a key but the question only
  // needs one of them. Joining anyway multiplies every row (and every sum)
  // by however many matches the join produces. Processed in reverse so a
  // join kept only because a LATER join depends on its columns isn't pruned
  // out from under it.
  if (repaired.joins?.length) {
    const usedColumns = new Set<string>([
      ...(repaired.filters ?? []).map((f) => f.column),
      ...(repaired.groupBy ?? []),
      ...(repaired.aggregations ?? []).map((a) => a.column),
      ...(repaired.select ?? []),
      ...(repaired.derive ?? []).flatMap((d) => d.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
      ...(repaired.correlate ? [repaired.correlate.columnX, repaired.correlate.columnY] : []),
      ...(repaired.dateBucket ? [repaired.dateBucket.column] : []),
      ...(repaired.chartX ? [repaired.chartX] : []),
      ...(repaired.chartY ?? []),
    ]);

    const chain = [base, ...joinedDatasets]; // index i = dataset joined at repaired.joins[i-1]
    const keptJoins = [...repaired.joins];
    for (let i = keptJoins.length - 1; i >= 0; i--) {
      const ds = chain[i + 1];
      if (!ds) continue;
      const providesUsedColumn = ds.columns.some((c) => usedColumns.has(c.name));
      // A later surviving join needs THIS dataset as a bridge if its leftOn
      // column belongs only to this dataset among everything before it.
      const isBridgeForLaterJoin = keptJoins.slice(i + 1).some((laterJoin) => {
        const priorChain = chain.slice(0, i + 1); // datasets available before this one
        return !priorChain.some((d) => d.columns.some((c) => c.name === laterJoin.leftOn)) &&
          ds.columns.some((c) => c.name === laterJoin.leftOn);
      });
      if (!providesUsedColumn && !isBridgeForLaterJoin) {
        repairs.push({ field: "joins", detail: `Dropped join to "${ds.name}" — nothing in the plan's output, filters, or grouping actually uses its columns; keeping it would multiply row counts for no reason.` });
        keptJoins.splice(i, 1);
        chain.splice(i + 1, 1);
      }
    }
    repaired.joins = keptJoins.length > 0 ? keptJoins : undefined;
  }

  // ── 5. Predict output columns, then make the chart point at them ────────
  const predictedColumns = predictOutputColumns(repaired, availableNames, bucketAlias);

  // "having" runs against the GROUPED result, so its columns must be ones
  // the aggregation actually produces (an alias or a group key) — not raw
  // source columns, which no longer exist at that point.
  if (repaired.having?.length) {
    if (!repaired.groupBy?.length && !repaired.aggregations?.length) {
      repairs.push({ field: "having", detail: `Dropped "having" — it filters grouped results, but this plan doesn't group or aggregate anything.` });
      repaired.having = undefined;
    } else {
      const kept = [];
      for (const h of repaired.having) {
        const match = predictedColumns.find((c) => c === h.column)
          ?? predictedColumns.find((c) => c.toLowerCase() === h.column.toLowerCase())
          ?? predictedColumns.find((c) => normalize(c) === normalize(h.column));
        if (!match) {
          repairs.push({ field: "having", detail: `Dropped "having" on "${h.column}" — the grouped result produces [${predictedColumns.join(", ")}], so there is nothing by that name to filter on.` });
          continue;
        }
        kept.push({ ...h, column: match });
      }
      repaired.having = kept.length > 0 ? kept : undefined;
    }
  }

  if (repaired.chartType && repaired.chartType !== "none") {
    const x = repaired.chartX && predictedColumns.includes(repaired.chartX)
      ? repaired.chartX
      : predictedColumns.find((c) => !isLikelyMeasure(c, repaired));
    const ys = (repaired.chartY ?? []).filter((y) => predictedColumns.includes(y));
    const fallbackYs = predictedColumns.filter((c) => c !== x);

    const finalYs = ys.length > 0 ? ys : fallbackYs;
    if (!x || finalYs.length === 0) {
      repairs.push({ field: "chart", detail: `Removed chart — the plan produces no column pair to plot (${predictedColumns.join(", ") || "no columns"}).` });
      repaired.chartType = "none";
      repaired.chartX = undefined;
      repaired.chartY = undefined;
    } else {
      if (x !== repaired.chartX) {
        repairs.push({ field: "chartX", detail: `Chart x-axis "${repaired.chartX ?? "(unset)"}" isn't in the result → using "${x}".` });
        repaired.chartX = x;
      }
      if (finalYs.join(",") !== (repaired.chartY ?? []).join(",")) {
        repairs.push({ field: "chartY", detail: `Chart series ${JSON.stringify(repaired.chartY ?? [])} aren't all in the result → using ${JSON.stringify(finalYs)}.` });
        repaired.chartY = finalYs;
      }
    }
  }

  return { plan: repaired, repairs, predictedColumns };
}

const MAX_CATEGORICAL_CARDINALITY = 50;
const VALUE_SCAN_ROWS = 5000;

/**
 * Re-checks a plan against the ACTUAL joined data for a filter the question
 * clearly asked for but the plan omitted.
 *
 * A dropped filter is the worst failure this system can produce: "sales by
 * region for the Electronics category" without the category filter returns
 * every category's sales under regional labels — numbers that look entirely
 * plausible and are an order of magnitude wrong, with nothing to signal it.
 * Schema alone can't catch this (the filter VALUE lives in the data, not the
 * column names), so this runs after joins when real values are available.
 *
 * Deliberately conservative: only low-cardinality (categorical) columns are
 * considered, and only when exactly ONE of a column's values appears in the
 * question — an ambiguous mention is left alone rather than guessed at. Every
 * injection is reported, so a wrong guess is visible rather than silent.
 */
export function injectMissingValueFilters(
  plan: QueryPlan,
  question: string,
  rows: Record<string, unknown>[]
): { plan: QueryPlan; repairs: PlanRepair[] } {
  const repairs: PlanRepair[] = [];
  if (rows.length === 0) return { plan, repairs };

  const alreadyFiltered = new Set((plan.filters ?? []).map((f) => f.column));
  const sample = rows.slice(0, VALUE_SCAN_ROWS);
  const stringColumns = Object.keys(rows[0]).filter((c) => typeof rows[0][c] === "string");

  const injected: NonNullable<QueryPlan["filters"]> = [];

  for (const column of stringColumns) {
    if (alreadyFiltered.has(column)) continue;

    const distinct = new Set<string>();
    for (const row of sample) {
      const v = row[column];
      if (typeof v === "string" && v !== "") distinct.add(v);
      if (distinct.size > MAX_CATEGORICAL_CARDINALITY) break;
    }
    if (distinct.size === 0 || distinct.size > MAX_CATEGORICAL_CARDINALITY) continue;

    const mentioned = Array.from(distinct).filter((v) => v.length >= 3 && mentionsWholeValue(question, v));
    if (mentioned.length !== 1) continue; // 0 = not asked for, >1 = ambiguous

    injected.push({ column, op: "eq", value: mentioned[0] });
    repairs.push({
      field: "filters",
      detail: `Question names "${mentioned[0]}" but the plan had no filter on "${column}" → added ${column} = "${mentioned[0]}".`,
    });
  }

  if (injected.length === 0) return { plan, repairs };
  return { plan: { ...plan, filters: [...(plan.filters ?? []), ...injected] }, repairs };
}

const ISO_DATE_VALUE = /^\d{4}-\d{2}(-\d{2})?/;
const ISO_DATE_CELL = /^\d{4}-\d{2}-\d{2}T/;

/**
 * A bare month/date reference with no year ("attendance for March") gives
 * the planner nothing to ground a year in, and a small model fills the gap
 * with whatever year it's seen most in training — not necessarily the year
 * actually in the file. If the filtered year doesn't exist in the data at
 * all AND the data only spans a single year, that's almost certainly a
 * hallucinated year rather than a real "no data for that period" case
 * (e.g. "sales for Q3" correctly matches the year but not the quarter, and
 * is deliberately left alone here). Runs after joins, on real values.
 */
export function correctHallucinatedDateFilterYear(
  plan: QueryPlan,
  rows: Record<string, unknown>[]
): { plan: QueryPlan; repairs: PlanRepair[] } {
  const repairs: PlanRepair[] = [];
  if (!plan.filters?.length || rows.length === 0) return { plan, repairs };

  const filters = plan.filters.map((f) => {
    if (!["eq", "gte", "lte", "gt", "lt"].includes(f.op)) return f;
    if (typeof f.value !== "string" || !ISO_DATE_VALUE.test(f.value)) return f;

    const sample = rows.find((r) => typeof r[f.column] === "string" && ISO_DATE_CELL.test(r[f.column] as string));
    if (!sample) return f; // not actually a date column

    const filterYear = f.value.slice(0, 4);
    const actualYears = new Set(
      rows
        .map((r) => (typeof r[f.column] === "string" ? (r[f.column] as string).slice(0, 4) : null))
        .filter((y): y is string => y !== null)
    );
    if (actualYears.has(filterYear) || actualYears.size !== 1) return f;

    const correctYear = Array.from(actualYears)[0];
    const newValue = f.value.replace(/^\d{4}/, correctYear);
    repairs.push({
      field: "filters",
      detail: `Filter on "${f.column}" used year ${filterYear}, but every row in this data is from ${correctYear} → corrected to ${newValue}.`,
    });
    return { ...f, value: newValue };
  });

  return { plan: { ...plan, filters }, repairs };
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const YEAR_MONTH_CELL = /^\d{4}-\d{2}$/;

/** The time period a question names, if any ("March 2025" → 2025-03). */
function parseQuestionPeriod(question: string): { year?: string; monthIdx?: number } | undefined {
  const lower = question.toLowerCase();
  const monthIdx = MONTH_NAMES.findIndex((m) => new RegExp(`\\b${m}\\b`).test(lower));
  const year = lower.match(/\b(19|20)\d{2}\b/)?.[0];
  if (monthIdx === -1 && !year) return undefined;
  return { year, monthIdx: monthIdx === -1 ? undefined : monthIdx };
}

// "since 2020", "2023 or later", "before March" describe an OPEN-ENDED
// period — pinning them to one bounded month/year would answer a narrower
// question than the one asked, so period injection stays out of it.
const OPEN_ENDED_PERIOD = /\b(or later|onwards?|since|after|before|until|up to|prior to|from)\b/i;

/**
 * Aligns a question's stated time period with the column that actually
 * stores it. Handles three failures seen in real traces, all of which
 * otherwise produce a confidently wrong number:
 *
 *  1. The planner writes the period the way the QUESTION phrased it
 *     ("March 2025", or a bare 3) against a column holding "2025-03" —
 *     an eq that can never match, silently returning nothing.
 *  2. The planner drops the period filter entirely (often because an
 *     earlier repair removed a malformed one), leaving an unfiltered total
 *     presented as if it answered "in March 2025".
 *  3. The period is right but the column is a full ISO date, needing a
 *     range rather than an equality.
 *
 * Deliberately conservative: it never touches an existing gte/lte/gt/lt
 * (those are already a correctly-shaped range, e.g. "joined in 2023 or
 * later"), and never fires for open-ended phrasing.
 */
export function resolveTimeFilters(
  plan: QueryPlan,
  question: string,
  rows: Record<string, unknown>[]
): { plan: QueryPlan; repairs: PlanRepair[] } {
  const repairs: PlanRepair[] = [];
  if (rows.length === 0) return { plan, repairs };

  const period = parseQuestionPeriod(question);
  if (!period) return { plan, repairs };

  // Which column actually stores a period, and in what shape?
  const sampleRow = rows.find((r) => Object.values(r).some((v) => typeof v === "string")) ?? rows[0];
  let column: string | undefined;
  let shape: "year-month" | "iso-date" | undefined;
  for (const key of Object.keys(sampleRow)) {
    const value = rows.find((r) => typeof r[key] === "string")?.[key];
    if (typeof value !== "string") continue;
    if (YEAR_MONTH_CELL.test(value)) { column = key; shape = "year-month"; break; }
    if (ISO_DATE_CELL.test(value) && !column) { column = key; shape = "iso-date"; }
  }
  if (!column || !shape) return { plan, repairs };

  // An existing range filter is already the right shape — leave it be.
  const existing = (plan.filters ?? []).filter((f) => f.column === column);
  if (existing.some((f) => ["gt", "gte", "lt", "lte"].includes(f.op))) return { plan, repairs };

  const actualYears = new Set(
    rows.map((r) => (typeof r[column!] === "string" ? (r[column!] as string).slice(0, 4) : null)).filter((y): y is string => y !== null)
  );
  const year = period.year ?? (actualYears.size === 1 ? Array.from(actualYears)[0] : undefined);
  if (!year) return { plan, repairs };

  // An eq filter that DOES match real values is already correct.
  const equality = existing.find((f) => f.op === "eq");
  if (equality && rows.some((r) => String(r[column!]) === String(equality.value))) return { plan, repairs };
  if (!equality && OPEN_ENDED_PERIOD.test(question)) return { plan, repairs };

  const others = (plan.filters ?? []).filter((f) => f.column !== column);
  const month = period.monthIdx !== undefined ? String(period.monthIdx + 1).padStart(2, "0") : undefined;

  let injected: NonNullable<QueryPlan["filters"]>;
  let describe: string;
  if (shape === "year-month") {
    injected = month
      ? [{ column, op: "eq", value: `${year}-${month}` }]
      : [{ column, op: "gte", value: `${year}-01` }, { column, op: "lte", value: `${year}-12` }];
    describe = month ? `${column} = "${year}-${month}"` : `${column} within ${year}`;
  } else {
    const lastDay = month ? new Date(Number(year), Number(month), 0).getDate() : 31;
    injected = month
      ? [
          { column, op: "gte", value: `${year}-${month}-01` },
          { column, op: "lte", value: `${year}-${month}-${String(lastDay).padStart(2, "0")}` },
        ]
      : [{ column, op: "gte", value: `${year}-01-01` }, { column, op: "lte", value: `${year}-12-31` }];
    describe = month ? `${column} within ${year}-${month}` : `${column} within ${year}`;
  }

  repairs.push({
    field: "filters",
    detail: equality
      ? `Filter "${column} eq ${JSON.stringify(equality.value)}" matches no value in this column (it stores ${shape === "year-month" ? `"YYYY-MM"` : "full dates"}) → replaced with ${describe}, the period the question names.`
      : `The question names a time period but the plan had no filter for it → added ${describe}, so the total covers only that period rather than every row.`,
  });

  return { plan: { ...plan, filters: [...others, ...injected] }, repairs };
}

/**
 * A range filter (gte/lte/gt/lt) on a string column only makes sense if its
 * value is in the same format as the column's actual values ("2025-01" vs
 * "2025-01"); a planner sometimes writes a plausible-looking but
 * differently-formatted value ("January" against a column that actually
 * holds "2025-01") that can never lexically compare true against anything,
 * silently zeroing the whole result with no error. If a range filter
 * matches literally zero rows against the FULL (pre-filter) data, that's a
 * format mismatch, not a real "nothing in range" case — drop it. Scoped to
 * range ops only (not eq) so a genuine "no rows have this exact value" case
 * elsewhere is left alone; date-shaped values are left to the dedicated
 * date-year correction above.
 */
export function dropUnsatisfiableRangeFilters(
  plan: QueryPlan,
  rows: Record<string, unknown>[]
): { plan: QueryPlan; repairs: PlanRepair[] } {
  const repairs: PlanRepair[] = [];
  if (!plan.filters?.length || rows.length === 0) return { plan, repairs };

  const kept = plan.filters.filter((f) => {
    if (!["gt", "gte", "lt", "lte"].includes(f.op)) return true;
    if (typeof f.value !== "string" || ISO_DATE_VALUE.test(f.value)) return true;
    const sample = rows.find((r) => typeof r[f.column] === "string");
    if (!sample || typeof sample[f.column] !== "string") return true; // not a string column

    const strVal = f.value.toLowerCase();
    const matches = rows.some((r) => {
      if (typeof r[f.column] !== "string") return false;
      const strCell = (r[f.column] as string).toLowerCase();
      switch (f.op) {
        case "gt": return strCell > strVal;
        case "gte": return strCell >= strVal;
        case "lt": return strCell < strVal;
        case "lte": return strCell <= strVal;
        default: return false;
      }
    });
    if (matches) return true;

    repairs.push({
      field: "filters",
      detail: `Dropped filter "${f.column} ${f.op} ${f.value}" — no value in this column has a comparable format, so it matched nothing (likely a value-format mismatch, not real data absence).`,
    });
    return false;
  });

  return { plan: { ...plan, filters: kept.length > 0 ? kept : undefined }, repairs };
}

function mentionsWholeValue(question: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(question);
}

// Output columns an executed plan will produce, mirroring query-engine.ts.
function predictOutputColumns(plan: QueryPlan, availableNames: string[], bucketAlias?: string): string[] {
  const withBucket = bucketAlias ? [...availableNames, bucketAlias] : availableNames;

  if (plan.groupBy?.length || plan.aggregations?.length) {
    const cols = [...(plan.groupBy ?? [])];
    if (plan.aggregations?.length) {
      for (const a of plan.aggregations) cols.push(a.as ?? `${a.fn}_${a.column}`);
    } else {
      cols.push("count");
    }
    return cols;
  }

  if (plan.select?.length) {
    const valid = plan.select.filter((c) => withBucket.includes(c));
    if (valid.length > 0) return valid;
  }
  return withBucket;
}

function isLikelyMeasure(column: string, plan: QueryPlan): boolean {
  return (plan.aggregations ?? []).some((a) => (a.as ?? `${a.fn}_${a.column}`) === column);
}

// A column the plan needs (aggregation target, implied groupBy dimension)
// can live in a dataset the plan never joined at all. If some relationship
// connects that dataset to one already in the plan, pull it in — mutating
// `repaired.joins`, `availableColumns` and `includedIds` in place — instead
// of silently dropping the field that needed it.
function autoIncludeDatasetWithColumn(
  columnName: string,
  preferType: ColumnSchema["type"] | undefined,
  datasets: ValidatorDataset[],
  includedIds: string[],
  relationships: RelationshipRecord[],
  availableColumns: ColumnSchema[],
  joinedDatasets: ValidatorDataset[],
  repaired: QueryPlan,
  repairs: PlanRepair[]
): string | undefined {
  for (const ds of datasets) {
    if (includedIds.includes(ds.id)) continue;
    const col = resolveColumn(columnName, ds.columns);
    if (!col) continue;
    const colSchema = ds.columns.find((c) => c.name === col);
    if (preferType && colSchema?.type !== preferType) continue;
    const rel = bestRelationshipAmong(includedIds, ds.id, relationships);
    if (!rel) continue;

    repaired.joins = [...(repaired.joins ?? []), { datasetId: ds.id, leftOn: rel.leftOn, rightOn: rel.rightOn, type: "inner" }];
    joinedDatasets.push(ds);
    includedIds.push(ds.id);
    for (const c of ds.columns) if (!availableColumns.some((a) => a.name === c.name)) availableColumns.push(c);
    repairs.push({
      field: "joins",
      detail: `Question needs "${col}" from "${ds.name}", which the plan never joined → added join to "${ds.name}" (${rel.leftOn} = ${rel.rightOn}, detected by ${rel.basis}).`,
    });
    return col;
  }
  return undefined;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The planner refers to datasets by NAME (ids are opaque random strings it
 * gets wrong). Accepts an id too, so older/heuristic plans keep working,
 * then falls back through progressively looser name matching.
 */
function resolveDatasetRef(ref: string | undefined, datasets: ValidatorDataset[]): ValidatorDataset | undefined {
  if (!ref) return undefined;
  const byId = datasets.find((d) => d.id === ref);
  if (byId) return byId;

  const exact = datasets.find((d) => d.name === ref);
  if (exact) return exact;

  const ci = datasets.find((d) => d.name.toLowerCase() === ref.toLowerCase().trim());
  if (ci) return ci;

  const loose = datasets.find((d) => normalize(d.name) === normalize(ref));
  if (loose) return loose;

  // a bare workbook name when the datasets are its individual sheets
  // ("book.xlsx" vs "book.xlsx — Sheet1"): only accept it if exactly one
  // candidate matches,
  // so an ambiguous prefix isn't silently resolved to the wrong sheet.
  const partial = datasets.filter(
    (d) => normalize(d.name).includes(normalize(ref)) || normalize(ref).includes(normalize(d.name))
  );
  return partial.length === 1 ? partial[0] : undefined;
}

/** Every column name the plan actually references, anywhere. */
function referencedColumns(plan: QueryPlan): string[] {
  return [
    ...(plan.aggregations ?? []).filter((a) => a.fn !== "count").map((a) => a.column),
    ...(plan.groupBy ?? []),
    ...(plan.filters ?? []).map((f) => f.column),
    ...(plan.select ?? []),
    ...(plan.derive ?? []).flatMap((d) => d.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
    ...(plan.correlate ? [plan.correlate.columnX, plan.correlate.columnY] : []),
    ...(plan.dateBucket ? [plan.dateBucket.column] : []),
  ].filter(Boolean);
}

/**
 * Detects a mis-picked base dataset and names the one that should have been
 * used. Deliberately strict: it only fires when the base contributes NOTHING
 * (not a single referenced column), which is the unambiguous signature of
 * the planner copying the wrong dataset reference. A legitimate fact-table
 * base always contributes at least its measure column, so the normal
 * "base + lookup joins" shape is never touched.
 */
function findBetterBase(
  plan: QueryPlan,
  base: ValidatorDataset,
  datasets: ValidatorDataset[]
): { dataset: ValidatorDataset; missing: string[] } | undefined {
  const referenced = Array.from(new Set(referencedColumns(plan)));
  if (referenced.length === 0) return undefined;

  const hasColumn = (d: ValidatorDataset, name: string) => Boolean(resolveColumn(name, d.columns));
  const fromBase = referenced.filter((c) => hasColumn(base, c));
  if (fromBase.length > 0) return undefined; // base contributes → leave it alone

  const scored = datasets
    .filter((d) => d.id !== base.id)
    .map((d) => ({ dataset: d, hits: referenced.filter((c) => hasColumn(d, c)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) return undefined;
  // Require a clear winner, so an arbitrary pick isn't made between ties.
  if (scored.length > 1 && scored[0].hits === scored[1].hits) return undefined;
  return { dataset: scored[0].dataset, missing: referenced };
}

function resolveColumn(name: string | undefined, columns: ColumnSchema[]): string | undefined {
  if (!name) return undefined;
  const exact = columns.find((c) => c.name === name);
  if (exact) return exact.name;
  const ci = columns.find((c) => c.name.toLowerCase() === name.toLowerCase().trim());
  if (ci) return ci.name;
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const loose = columns.find((c) => normalized(c.name) === normalized(name));
  return loose?.name;
}

// Finds the best relationship connecting `otherId` to ANY dataset already
// included in the plan (base + everything joined so far) — a third dataset
// commonly relates only to an intermediate one, not the base itself.
function bestRelationshipAmong(
  includedIds: string[],
  otherId: string,
  relationships: RelationshipRecord[]
): { leftOn: string; rightOn: string; basis: string } | undefined {
  const candidates = relationships.filter(
    (r) =>
      (includedIds.includes(r.datasetIdA) && r.datasetIdB === otherId) ||
      (includedIds.includes(r.datasetIdB) && r.datasetIdA === otherId)
  );
  if (candidates.length === 0) return undefined;
  // Prefer a high-confidence, non-numeric key — numeric "year"-style columns
  // match by name across unrelated datasets and make poor sole join keys.
  const scored = candidates.map((r) => ({
    rel: r,
    score: r.confidence + (looksLikeEntityKey(r.columnA) ? 0.5 : 0),
  }));
  const rel = scored.reduce((best, c) => (c.score > best.score ? c : best)).rel;
  const otherIsA = rel.datasetIdA === otherId;
  return { leftOn: otherIsA ? rel.columnB : rel.columnA, rightOn: otherIsA ? rel.columnA : rel.columnB, basis: rel.basis };
}

function looksLikeEntityKey(column: string): boolean {
  return !/^(year|month|day|quarter|week)$/i.test(column);
}

function impliedTimeGranularity(question: string): "day" | "month" | "year" | undefined {
  if (/\b(daily|per day|by day|day[- ]over[- ]day)\b/i.test(question)) return "day";
  if (/\b(monthly|per month|by month|month[- ]over[- ]month)\b/i.test(question)) return "month";
  if (/\b(yearly|annually|annual|per year|by year|year[- ]over[- ]year)\b/i.test(question)) return "year";
  // A bare "trend"/"over time" has no stated granularity; month is the
  // conventional default for business time series.
  if (/\b(trend|over time|timeline)\b/i.test(question)) return "month";
  return undefined;
}

const GROUP_BY_PHRASE = /\b(?:by|per|for each|across each|broken down by|grouped by)\s+([a-z0-9_ ]{2,40})/i;

function impliedGroupByColumn(question: string, columns: ColumnSchema[], bucketAlias?: string): string | undefined {
  const match = question.match(GROUP_BY_PHRASE);
  if (!match) return undefined;
  const phrase = match[1].toLowerCase().trim();

  // A time phrase is already handled by dateBucket, if one was planned.
  if (/^(year|month|day|quarter|week)s?\b/.test(phrase) && bucketAlias) return bucketAlias;

  const candidates = columns.filter((c) => c.type !== "number");
  const direct = candidates.find((c) => phrase.startsWith(c.name.toLowerCase()) || phrase === c.name.toLowerCase());
  if (direct) return direct.name;

  const words = phrase.split(/\s+/);
  for (const word of words) {
    const singular = word.replace(/s$/, "");
    const hit = candidates.find(
      (c) => c.name.toLowerCase() === word || c.name.toLowerCase() === singular || c.name.toLowerCase().endsWith(`_${singular}`)
    );
    if (hit) return hit.name;
  }
  return undefined;
}

function pickBestDataset(question: string, datasets: ValidatorDataset[]): ValidatorDataset | undefined {
  const q = question.toLowerCase();
  let best: ValidatorDataset | undefined;
  let bestScore = -1;
  for (const d of datasets) {
    let score = 0;
    if (q.includes(d.name.toLowerCase().replace(/\.(csv|xlsx?)$/i, ""))) score += 5;
    for (const c of d.columns) if (q.includes(c.name.toLowerCase())) score += 1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
