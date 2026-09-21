import { AggregateFn, ChartType, FilterOp, QueryAggregation, QueryFilter, QueryPlan, QuerySort } from "./types";
import { RelationshipRecord } from "./session-store";
import { SemanticField, SemanticModel } from "./semantic-model";
import { findJoinPath } from "./schema-linking";
import { joinPrefix } from "./query-engine";

/**
 * Compiles a SELECTION — what to measure, what to slice by, what to filter —
 * into the executable QueryPlan the engine already understands. The planner
 * never writes a join: it names fields from the semantic menu, and this
 * file works out the base table, the join chain and the post-join column
 * names. If the selection is right, the joins are right by construction.
 *
 * Everything here is derived from the semantic model and the relationship
 * graph. The compiler has no opinion about what a question means; it only
 * turns a set of field references into the plan that reaches them.
 */

export interface SelectionMeasure { ref: string; fn: AggregateFn; as?: string; /** conditions for this measure only (count-if, sum-if, "value where parameter is X") */ where?: SelectionFilter[] }
export interface SelectionFilter { ref: string; op: FilterOp; value?: string | number | boolean | (string | number)[]; /** compare with another field instead of a constant */ valueRef?: string }

export interface Selection {
  measures?: SelectionMeasure[];
  /** Field refs to group by ("members.city"). */
  dimensions?: string[];
  filters?: SelectionFilter[];
  /** Arithmetic over field refs or bare columns; the alias becomes a measure. */
  derive?: { as: string; expr: string }[];
  dateBucket?: { ref: string; granularity: "day" | "month" | "year"; as?: string };
  /** Applied after grouping, on measure aliases. */
  having?: (QueryFilter & { /** compare with another measure alias instead of a constant */ valueRef?: string })[];
  /**
   * Anti-join: keep only base rows with NO match in these tables
   * ("members without loans"). Compiled to a left join + isNull.
   */
  without?: string[];
  /** Columns to show for a row listing (refs). */
  select?: string[];
  sort?: QuerySort[];
  limit?: number;
  correlate?: { x: string; y: string };
  chartType?: ChartType;
  chartX?: string;
  chartY?: string[];
  reasoning?: string;
}

export interface CompiledSelection {
  /** The (first) plan — for a single-fact selection, the only one. */
  plan: QueryPlan;
  /**
   * When measures come from several fact tables, one plan PER fact table,
   * each aggregated at the requested dimensions on its own. Joining two
   * fact tables before aggregating is the classic "chasm trap": one side's
   * rows repeat, the other's unmatched rows vanish, and both totals are
   * wrong. Aggregating separately and merging the RESULTS on the dimension
   * values (what BI semantic layers call symmetric/multi-fact aggregation)
   * is the standard, correct way to answer "X vs Y" across tables.
   */
  plans: QueryPlan[];
  /** Number of leading output columns (the dimensions) the sub-results merge on. */
  mergeDimensionCount: number;
  /** What the compiler decided and anything it had to drop. */
  notes: string[];
  /**
   * Tables the selection referenced that the compiler left out ON PURPOSE.
   * Downstream checks must treat these as reached, not as forgotten.
   */
  excludedDatasetIds: string[];
}

interface CompileOptions {
  /** Use this table as the base regardless of weights (multi-fact sub-plan). */
  forceBaseId?: string;
  /** Part of a multi-fact composition: other tables' measures belong to sibling plans, not to a warning. */
  composite?: boolean;
}

/** True when a parsed object looks like a selection rather than a raw plan. */
export function looksLikeSelection(obj: unknown): obj is Selection {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if ("datasetId" in o) return false;
  return "measures" in o || "dimensions" in o || "select" in o || "without" in o || "correlate" in o;
}

interface Resolved { field: SemanticField; datasetId: string }

/**
 * What a selection COMPUTES, independent of how it labels or presents it:
 * two drafts with the same signature answer the same question, whatever
 * their "as" names, sort, limit, chart or reasoning say.
 */
export function selectionSignature(sel: Selection): string {
  const low = (s: unknown) => String(s ?? "").toLowerCase();
  const filt = (f: SelectionFilter) => `${low(f.ref)} ${f.op} ${f.valueRef ? "ref:" + low(f.valueRef) : JSON.stringify(f.value ?? null).toLowerCase()}`;
  const sig = {
    m: (sel.measures ?? []).map((m) => `${m.fn}(${low(m.ref)})${m.where?.length ? " where " + m.where.map(filt).sort().join(" & ") : ""}`).sort(),
    d: (sel.dimensions ?? []).map(low).sort(),
    f: (sel.filters ?? []).map(filt).sort(),
    x: (sel.derive ?? []).map((d) => low(d.expr).replace(/\s+/g, "")).sort(),
    h: (sel.having ?? []).map((h) => `${low(h.column)} ${h.op} ${h.valueRef ?? h.value}`).sort(),
    w: (sel.without ?? []).map(low).sort(),
    b: sel.dateBucket ? `${low(sel.dateBucket.ref)}:${sel.dateBucket.granularity}` : "",
    c: sel.correlate ? `${low(sel.correlate.x)}~${low(sel.correlate.y)}` : "",
  };
  return JSON.stringify(sig);
}

export function compileSelection(sel: Selection, model: SemanticModel): CompiledSelection {
  // Which fact tables do the additive measures come from? One → the plain
  // path. Several → one sub-plan per fact table, merged on the dimensions.
  const factTables = factTablesOf(sel, model);
  if (factTables.length <= 1) return compileOne(sel, model, {});

  const parts = factTables.map((id) => compileOne(sel, model, { forceBaseId: id, composite: true }));
  const nameOf = (id: string) => model.tables.find((t) => t.datasetId === id)?.name ?? id;
  const notes = [
    `Measures come from ${factTables.length} tables (${factTables.map(nameOf).join(", ")}); each is aggregated separately and the results are merged on the dimensions, so neither table's rows are multiplied or dropped by the other.`,
    ...parts.flatMap((p, i) => p.notes.map((n) => `[${nameOf(factTables[i])}] ${n}`)),
  ];
  const dims = (sel.dimensions ?? []).length + (sel.dateBucket ? 1 : 0);
  return {
    plan: parts[0].plan,
    plans: parts.map((p) => p.plan),
    mergeDimensionCount: dims,
    notes,
    excludedDatasetIds: [],
  };
}

/** Distinct tables holding the selection's additive (sum/avg/count) measures, incl. derive sources. */
function factTablesOf(sel: Selection, model: SemanticModel): string[] {
  const byRef = new Map<string, SemanticField>();
  for (const f of [...model.measures, ...model.dimensions]) byRef.set(f.ref.toLowerCase(), f);
  const deriveTables = new Map<string, string>();
  for (const d of sel.derive ?? []) {
    for (const m of d.expr.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const f = byRef.get(m[0].toLowerCase());
      if (f) { deriveTables.set(d.as, f.datasetId); break; }
    }
  }
  const out: string[] = [];
  for (const m of sel.measures ?? []) {
    if (!(m.fn === "sum" || m.fn === "avg" || m.fn === "count")) continue;
    const id = byRef.get(m.ref.toLowerCase())?.datasetId ?? deriveTables.get(m.ref);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function compileOne(sel: Selection, model: SemanticModel, opts: CompileOptions): CompiledSelection {
  const notes: string[] = [];
  const byRef = new Map<string, SemanticField>();
  const byColumn = new Map<string, SemanticField[]>();
  const byAlias = new Map<string, string>(); // alias → datasetId
  for (const t of model.tables) byAlias.set(t.alias.toLowerCase(), t.datasetId);
  for (const f of [...model.measures, ...model.dimensions]) {
    byRef.set(f.ref.toLowerCase(), f);
    (byColumn.get(f.column.toLowerCase()) ?? byColumn.set(f.column.toLowerCase(), []).get(f.column.toLowerCase())!).push(f);
  }
  const derivedAliases = new Set((sel.derive ?? []).map((d) => d.as));

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  /** "alias.column", or a bare column unique across tables, or a derived alias. */
  const resolve = (ref: string, what: string): Resolved | "derived" | undefined => {
    if (derivedAliases.has(ref)) return "derived";
    const direct = byRef.get(ref.toLowerCase());
    if (direct) return { field: direct, datasetId: direct.datasetId };
    // Tolerate "alias.column" with drift in either part.
    const dot = ref.indexOf(".");
    if (dot > 0) {
      const a = ref.slice(0, dot), c = ref.slice(dot + 1);
      const hit = [...byRef.values()].find((f) => norm(f.alias) === norm(a) && norm(f.column) === norm(c));
      if (hit) return { field: hit, datasetId: hit.datasetId };
    }
    const bare = byColumn.get(ref.toLowerCase()) ?? [...byColumn.entries()].find(([k]) => norm(k) === norm(ref))?.[1];
    if (bare && bare.length === 1) return { field: bare[0], datasetId: bare[0].datasetId };
    if (bare && bare.length > 1) {
      notes.push(`"${ref}" (${what}) exists in ${bare.map((b) => b.alias).join(", ")} — say which by writing alias.column; dropped.`);
      return undefined;
    }
    notes.push(`"${ref}" (${what}) is not in the menu; dropped.`);
    return undefined;
  };

  // ── 1. Resolve every reference and note which tables are touched ─────────
  const touched = new Map<string, number>(); // datasetId → weight
  const touch = (id: string, w = 1) => touched.set(id, (touched.get(id) ?? 0) + w);

  const measures = (sel.measures ?? []).map((m) => ({ m, r: resolve(m.ref, "measure") })).filter((x) => x.r);
  const dimensions = (sel.dimensions ?? []).map((d) => ({ d, r: resolve(d, "dimension") })).filter((x) => x.r);
  // A key dimension whose readable label is known elsewhere is shown with
  // that label. Grouping by id AND its name yields the same groups (the name
  // depends on the id), so this changes nothing but the legibility.
  for (const x of [...dimensions]) {
    if (x.r === "derived" || !x.r?.field.isKey || !x.r.field.labelRef) continue;
    const labelRef = x.r.field.labelRef;
    if (dimensions.some((y) => y.d.toLowerCase() === labelRef.toLowerCase())) continue;
    const lr = resolve(labelRef, "label");
    if (lr && lr !== "derived") { dimensions.push({ d: labelRef, r: lr }); notes.push(`Added ${labelRef} alongside ${x.d} for readability.`); }
  }
  const filters = (sel.filters ?? []).map((f) => ({ f, r: resolve(f.ref, "filter") })).filter((x) => x.r);
  const measureConditionRefs = (sel.measures ?? []).flatMap((m) => (m.where ?? []).flatMap((f) => [f.ref, ...(f.valueRef ? [f.valueRef] : [])])).map((ref) => ({ s: ref, r: resolve(ref, "measure condition") })).filter((x) => x.r);
  // A filter comparing two fields needs both fields' tables.
  const comparisonRefs = (sel.filters ?? []).filter((f) => f.valueRef).map((f) => ({ s: f.valueRef!, r: resolve(f.valueRef!, "filter comparison") })).filter((x) => x.r);
  const selects = (sel.select ?? []).map((s) => ({ s, r: resolve(s, "select") })).filter((x) => x.r);
  // Same courtesy for a selected id: a "who" answered with ids alone is
  // unreadable, and the label adds no rows.
  for (const x of [...selects]) {
    if (x.r === "derived" || !x.r?.field.isKey || !x.r.field.labelRef) continue;
    const labelRef = x.r.field.labelRef;
    if (selects.some((y) => y.s.toLowerCase() === labelRef.toLowerCase())) continue;
    const lr = resolve(labelRef, "label");
    if (lr && lr !== "derived") { selects.push({ s: labelRef, r: lr }); notes.push(`Added ${labelRef} alongside ${x.s} for readability.`); }
  }
  const bucket = sel.dateBucket ? { b: sel.dateBucket, r: resolve(sel.dateBucket.ref, "dateBucket") } : undefined;
  const measureAliasSet = new Set((sel.measures ?? []).map((m) => m.as).filter((a): a is string => Boolean(a)));
  const corr = sel.correlate
    ? { x: measureAliasSet.has(sel.correlate.x) ? undefined : resolve(sel.correlate.x, "correlate"), y: measureAliasSet.has(sel.correlate.y) ? undefined : resolve(sel.correlate.y, "correlate") }
    : undefined;

  // Measures anchor the base most strongly: the table whose rows are being
  // summed is the fact table, and everything else joins onto it.
  for (const x of measures) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 3);
  for (const x of dimensions) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 1);
  for (const x of filters) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 1);
  for (const x of selects) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 1);
  for (const x of comparisonRefs) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 1);
  for (const x of measureConditionRefs) if (x.r !== "derived" && x.r) touch(x.r.datasetId, 1);
  if (bucket?.r && bucket.r !== "derived") touch(bucket.r.datasetId, 1);
  if (corr?.x && corr.x !== "derived") touch(corr.x.datasetId, 3);
  if (corr?.y && corr.y !== "derived") touch(corr.y.datasetId, 3);

  // Derive expressions may reference alias.column or bare columns.
  const deriveRefs: { as: string; expr: string; refs: Resolved[] }[] = [];
  for (const d of sel.derive ?? []) {
    const refs: Resolved[] = [];
    for (const m of d.expr.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const token = m[0];
      if (/^\d/.test(token)) continue;
      const r = resolve(token, `derive "${d.as}"`);
      if (r && r !== "derived") { refs.push(r); touch(r.datasetId, 3); }
    }
    deriveRefs.push({ as: d.as, expr: d.expr, refs });
  }

  const withoutIds = (sel.without ?? []).map((a) => byAlias.get(a.toLowerCase()) ?? model.tables.find((t) => norm(t.alias) === norm(a) || norm(t.name) === norm(a))?.datasetId).filter((x): x is string => Boolean(x));

  if (touched.size === 0 && withoutIds.length === 0) {
    notes.push("Nothing in the selection resolved to a field.");
    const plan = { datasetId: model.tables[0]?.datasetId ?? "" };
    return { plan, plans: [plan], mergeDimensionCount: 0, notes, excludedDatasetIds: [] };
  }

  // ── 2. Base table: heaviest weight, ties → most rows ─────────────────────
  const rowsOf = (id: string) => model.tables.find((t) => t.datasetId === id)?.rowCount ?? 0;
  const candidates = [...touched.entries()].filter(([id]) => !withoutIds.includes(id));
  const baseId = opts.forceBaseId ?? (candidates.length ? candidates : [...touched.entries()])
    .sort((a, b) => b[1] - a[1] || rowsOf(b[0]) - rowsOf(a[0]))[0][0];
  const nameOf = (id: string) => model.tables.find((t) => t.datasetId === id)?.name ?? id;
  notes.push(`Base: ${nameOf(baseId)}`);

  // Totals from two different tables cannot share one query: joining them
  // duplicates one side's rows and drops the other's unmatched rows, so at
  // least one total comes out wrong. Such measures are dropped here, before
  // the join chain is built, so their table is not joined either — a join
  // that nothing uses would still silently shrink the base to matched rows.
  const deriveTable = (as: string) => deriveRefs.find((d) => d.as === as)?.refs[0]?.datasetId;
  const isDroppedMeasure = (m: SelectionMeasure, r: Resolved | "derived") => {
    if (!(m.fn === "sum" || m.fn === "avg" || m.fn === "count")) return false;
    const table = r === "derived" ? deriveTable(m.ref) : r.datasetId;
    return table !== undefined && table !== baseId;
  };
  const droppedMeasures = measures.filter(({ m, r }) => isDroppedMeasure(m, r!)).map(({ m }) => `${m.fn}(${m.ref})`);
  const stillTouched = new Set<string>();
  for (const x of measures) if (x.r !== "derived" && x.r && !isDroppedMeasure(x.m, x.r)) stillTouched.add(x.r.datasetId);
  for (const x of [...dimensions, ...filters, ...selects, ...comparisonRefs, ...measureConditionRefs]) if (x.r !== "derived" && x.r) stillTouched.add(x.r.datasetId);
  if (bucket?.r && bucket.r !== "derived") stillTouched.add(bucket.r.datasetId);
  if (corr?.x && corr.x !== "derived") stillTouched.add(corr.x.datasetId);
  if (corr?.y && corr.y !== "derived") stillTouched.add(corr.y.datasetId);
  for (const d of deriveRefs) {
    // A derive that feeds a dropped (other-table) measure belongs to a
    // sibling plan; its columns must not drag that table into this one.
    const feedsKeptMeasure = measures.some(({ m, r }) => m.ref === d.as && !isDroppedMeasure(m, r!));
    if (feedsKeptMeasure || !measures.some(({ m }) => m.ref === d.as)) for (const r of d.refs) stillTouched.add(r.datasetId);
  }
  const excludedDatasetIds: string[] = [];
  if (droppedMeasures.length) {
    for (const x of measures) if (x.r !== "derived" && x.r && isDroppedMeasure(x.m, x.r) && !stillTouched.has(x.r.datasetId) && !excludedDatasetIds.includes(x.r.datasetId)) excludedDatasetIds.push(x.r.datasetId);
    if (!opts.composite) notes.push(`Dropped ${droppedMeasures.join(", ")}: a total from a second table cannot be combined with "${nameOf(baseId)}" totals in one query without double-counting — ask for it separately.`);
  }

  // ── 3. Join chain: reach every other touched table from what's included ─
  const rels: RelationshipRecord[] = model.relationships;
  const joins: NonNullable<QueryPlan["joins"]> = [];
  const included = new Set([baseId]);
  const withoutHops = new Map<string, number>();
  const targets = [...new Set([...stillTouched, ...withoutIds])].filter((id) => id !== baseId);
  for (const target of targets) {
    if (included.has(target)) continue;
    let best: ReturnType<typeof findJoinPath>;
    for (const start of included) {
      const p = findJoinPath(start, target, rels);
      if (p && (!best || p.length < best.length)) best = p;
    }
    if (!best) { notes.push(`No relationship connects ${nameOf(target)} to ${nameOf(baseId)}; its fields were dropped.`); continue; }
    const towardsWithout = withoutIds.includes(target);
    if (towardsWithout) withoutHops.set(target, best.length);
    for (const step of best) {
      if (included.has(step.datasetId)) continue;
      // Every hop on the way to an anti-joined table is a left join, or the
      // intermediate inner join would already drop the rows being looked for.
      const isWithout = withoutIds.includes(step.datasetId) || towardsWithout;
      joins.push({ datasetId: step.datasetId, leftOn: step.leftOn, rightOn: step.rightOn, type: isWithout ? "left" : "inner" });
      included.add(step.datasetId);
      notes.push(`Join: ${nameOf(step.datasetId)} on ${step.leftOn} = ${step.rightOn}${isWithout ? " (left — anti-join)" : ""}`);
    }
  }

  // ── 4. Post-join column names, exactly as the engine will produce them ──
  // The base keeps every name; a joined column that collides with a name
  // already present becomes "<prefix>_<column>"; a join's right key is not
  // carried (the base-side key stands in for it).
  const columnsOf = (id: string) => [...model.measures, ...model.dimensions].filter((f) => f.datasetId === id).map((f) => f.column);
  const present = new Set(columnsOf(baseId));
  const nameFor = new Map<string, string>(); // `${datasetId}|${column}` → post-join name
  for (const c of present) nameFor.set(`${baseId}|${c}`, c);
  for (const j of joins) {
    const prefix = joinPrefix(nameOf(j.datasetId));
    for (const c of columnsOf(j.datasetId)) {
      if (c === j.rightOn) { nameFor.set(`${j.datasetId}|${c}`, j.leftOn ?? c); continue; }
      const name = present.has(c) ? `${prefix}_${c}` : c;
      nameFor.set(`${j.datasetId}|${c}`, name);
      present.add(name);
    }
  }
  const colName = (r: Resolved) => {
    if (!included.has(r.datasetId)) return undefined;
    return nameFor.get(`${r.datasetId}|${r.field.column}`) ?? r.field.column;
  };
  const nameOrDerived = (r: Resolved | "derived", raw: string) => (r === "derived" ? raw : colName(r));

  // ── 5. Emit the plan ────────────────────────────────────────────────────
  const plan: QueryPlan = { datasetId: baseId };
  if (joins.length) plan.joins = joins;

  const keptDerives = deriveRefs.filter((d) => !measures.some(({ m, r }) => m.ref === d.as && isDroppedMeasure(m, r!)));
  if (keptDerives.length) {
    plan.derive = keptDerives.map((d) => {
      let expr = d.expr;
      for (const r of d.refs) {
        const post = colName(r);
        if (!post) continue;
        expr = expr.replace(new RegExp(`\\b${r.field.alias}\\.${r.field.column}\\b`, "g"), post);
        if (post !== r.field.column) expr = expr.replace(new RegExp(`(?<![A-Za-z0-9_.])${r.field.column}\\b`, "g"), post);
      }
      return { as: d.as, expr };
    });
  }

  const outFilters: QueryFilter[] = [];
  const multiHopWithout: { id: string; probeName: string }[] = [];
  for (const { f, r } of filters) {
    const col = nameOrDerived(r!, f.ref);
    if (!col) continue;
    if (f.valueRef) {
      const vr = resolve(f.valueRef, "filter comparison");
      const other = vr ? nameOrDerived(vr, f.valueRef) : undefined;
      if (!other) { notes.push(`Dropped filter on ${f.ref}: comparison field "${f.valueRef}" not found.`); continue; }
      outFilters.push({ column: col, op: f.op, value: "", compareTo: other });
      continue;
    }
    outFilters.push({ column: col, op: f.op, value: f.value ?? "" });
  }
  // Anti-join: a left join leaves unmatched base rows with no joined columns
  // at all; testing any joined non-key column for null keeps exactly those.
  for (const w of withoutIds) {
    const j = joins.find((x) => x.datasetId === w);
    if (!j) continue;
    const probe = columnsOf(w).find((c) => c !== j.rightOn) ?? columnsOf(w)[0];
    if (!probe) continue;
    const probeName = nameFor.get(`${w}|${probe}`) ?? probe;
    // Directly linked: rows with no partner carry a blank probe. Reached
    // through an intermediate table, the grouped form below is used instead.
    if ((withoutHops.get(w) ?? 1) <= 1) outFilters.push({ column: probeName, op: "isNull", value: "" });
    else multiHopWithout.push({ id: w, probeName });
  }
  if (outFilters.length) plan.filters = outFilters;

  if (bucket?.r) {
    const col = nameOrDerived(bucket.r, bucket.b.ref);
    if (col) plan.dateBucket = { column: col, granularity: bucket.b.granularity, as: bucket.b.as };
  }

  const groupBy = dimensions.map(({ d, r }) => nameOrDerived(r!, d)).filter((x): x is string => Boolean(x));
  if (plan.dateBucket) groupBy.unshift(plan.dateBucket.as ?? `${plan.dateBucket.column}_${plan.dateBucket.granularity}`);
  if (groupBy.length) plan.groupBy = groupBy;

  const aggregations: QueryAggregation[] = [];
  for (const { m, r } of measures) {
    if (isDroppedMeasure(m, r!)) continue;
    const col = nameOrDerived(r!, m.ref);
    if (!col) continue;
    const where: QueryFilter[] = [];
    for (const f of m.where ?? []) {
      const fr = resolve(f.ref, "measure condition");
      const fcol = fr ? nameOrDerived(fr, f.ref) : undefined;
      if (!fcol) { notes.push(`Dropped condition on ${f.ref} for ${m.fn}(${m.ref}): field not found.`); continue; }
      if (f.valueRef) {
        const vr = resolve(f.valueRef, "measure condition");
        const other = vr ? nameOrDerived(vr, f.valueRef) : undefined;
        if (other) where.push({ column: fcol, op: f.op, value: "", compareTo: other });
      } else where.push({ column: fcol, op: f.op, value: f.value ?? "" });
    }
    aggregations.push({ column: col, fn: m.fn, as: m.as, ...(where.length ? { where } : {}) });
  }
  if (aggregations.length) plan.aggregations = aggregations;

  if (selects.length) plan.select = selects.map(({ s, r }) => nameOrDerived(r!, s)).filter((x): x is string => Boolean(x));
  // An anti-join through an intermediate table (a station's sensors'
  // readings): an entity has no partner only when NONE of its intermediate
  // rows do — group by the selected fields, count the far table, keep zero.
  for (const { id, probeName } of multiHopWithout) {
    const groupCols = plan.select?.length ? plan.select : plan.groupBy ?? [];
    if (!groupCols.length) { plan.filters = [...(plan.filters ?? []), { column: probeName, op: "isNull", value: "" }]; continue; }
    const alias = `${model.tables.find((t) => t.datasetId === id)?.alias ?? "linked"}_rows`;
    plan.groupBy = groupCols;
    plan.select = undefined;
    plan.aggregations = [...(plan.aggregations ?? []), { column: probeName, fn: "count", as: alias }];
    plan.having = [...(plan.having ?? []), { column: alias, op: "eq", value: 0 }];
    notes.push(`Anti-join through an intermediate table: grouped by ${groupCols.join(", ")} and kept groups with ${alias} = 0.`);
  }
  // A sort or having may name a menu field ("alias.column") or an
  // aggregate's "as" name; the former is resolved to the real column, the
  // latter is kept as written. An unresolved sort silently sorted nothing.
  const outputName = (ref: string) => {
    const r = resolve(ref, "sort");
    return r ? nameOrDerived(r, ref) ?? ref : ref;
  };
  if (sel.having?.length) plan.having = sel.having.map(({ valueRef, ...h }) => ({ ...h, column: outputName(h.column), ...(valueRef ? { compareTo: outputName(valueRef) } : {}) }));
  if (sel.sort?.length) plan.sort = sel.sort.map((s) => ({ ...s, column: outputName(s.column) }));
  if (sel.limit != null) plan.limit = sel.limit;
  // A correlate side is a menu field, a derived alias, or the "as" name of
  // a measure ("correlate the two averages per person") — the last is what
  // a per-entity correlation needs and is kept as written.
  if (sel.correlate?.x && sel.correlate?.y) {
    const measureAliases = new Set((sel.measures ?? []).map((m) => m.as).filter((a): a is string => Boolean(a)));
    const side = (raw: string, r: Resolved | "derived" | undefined) => measureAliases.has(raw) ? raw : r ? nameOrDerived(r, raw) : undefined;
    const x = side(sel.correlate.x, corr?.x), y = side(sel.correlate.y, corr?.y);
    if (x && y) plan.correlate = { columnX: x, columnY: y };
    else notes.push(`Dropped correlate: "${sel.correlate.x}" / "${sel.correlate.y}" is neither a menu field nor a measure alias.`);
  }
  if (sel.chartType) plan.chartType = sel.chartType;
  if (sel.chartX) plan.chartX = sel.chartX;
  if (sel.chartY) plan.chartY = sel.chartY;
  if (sel.reasoning) plan.reasoning = sel.reasoning;

  return { plan, plans: [plan], mergeDimensionCount: (sel.dimensions ?? []).length + (sel.dateBucket ? 1 : 0), notes, excludedDatasetIds };
}
