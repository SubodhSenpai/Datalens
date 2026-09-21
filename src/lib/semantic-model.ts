import { ColumnSchema } from "./types";
import { RelationshipRecord } from "./session-store";
import { joinPrefix } from "./query-engine";

/**
 * An inferred semantic model over the uploaded files: what can be measured,
 * what it can be sliced by, and how the tables connect. The idea is the
 * "semantic layer" that BI tools put between a warehouse and an AI: the
 * model picks a measure and some dimensions from a menu, and a deterministic
 * engine works out the joins. That is the single strongest published result
 * for reliable natural-language analytics — because the join, the thing a
 * small model gets wrong most, is no longer its decision.
 *
 * Here the layer is not hand-authored; it is inferred from the column
 * profiles (unique keys) and the detected relationships. Nothing in this
 * file knows any business vocabulary: a column is a measure because it is
 * numeric and not a key, a dimension because it is categorical or a date.
 */

export interface SemanticTable {
  datasetId: string;
  name: string;
  /** Short, copyable handle used in refs: "members", "library_xlsx_Loans". */
  alias: string;
  rowCount: number;
  /** Columns that identify a row (unique) or take part in a relationship. */
  keyColumns: string[];
}

export interface SemanticField {
  /** "alias.column" — what the planner copies. */
  ref: string;
  datasetId: string;
  alias: string;
  column: string;
  type: ColumnSchema["type"];
  /** For dimensions: how many distinct values (a hint about grain). */
  distinctCount?: number;
  /** True for key/id columns offered as dimensions ("per member"). */
  isKey?: boolean;
  examples?: string[];
  /** All values, when the column has few enough to list. */
  values?: string[];
  /** For an id dimension: where a human-readable label for it lives. */
  labelRef?: string;
}

export interface SemanticModel {
  tables: SemanticTable[];
  measures: SemanticField[];
  dimensions: SemanticField[];
  relationships: RelationshipRecord[];
  /** Long-format layouts found: a child table's generic value column whose meaning a parent column names. */
  longFormats: LongFormat[];
  /** Columns that grade a row's validity (a QC flag), with their values. */
  qualityFlags: { datasetId: string; ref: string; column: string; values: string[] }[];
}

/**
 * The "long" (entity–attribute–value) layout common to sensor, survey and
 * lab exports: each row of the child holds ONE number in a generic
 * `value` column, and WHICH quantity it is comes from a parent column such
 * as `parameter` (with the unit beside it). "Average X" for a named
 * quantity then means: filter the parent to X, aggregate the child's value.
 */
export interface LongFormat {
  childId: string;
  valueRef: string;
  valueColumn: string;
  parentId: string;
  parameterRef: string;
  parameterColumn: string;
  parameterValues: string[];
  unitRef?: string;
}

const GENERIC_VALUE = /^(value|values|reading|readings|measurement|measurements|result|results|observation|obs|val|amount|quantity_value)$/i;
const UNIT_COLUMN = /^(unit|units|uom|unit_of_measure|measurement_unit)$/i;
const PARAMETER_COLUMN = /(parameter|param|metric|variable|measure|analyte|pollutant|indicator|quantity|species|attribute|property|sensor_type|measurement_type)/i;
const QUALITY_COLUMN = /(^|_)(quality|qc|qa|flag|flags|valid|validity|validated)(_|$)/i;

export interface ModelableDataset {
  id: string;
  name: string;
  rowCount: number;
  columns: ColumnSchema[];
}

/** Columns that take part in any detected relationship, per dataset. */
function relationshipColumns(relationships: RelationshipRecord[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (ds: string, col: string) => (m.get(ds) ?? m.set(ds, new Set()).get(ds)!).add(col);
  for (const r of relationships) { add(r.datasetIdA, r.columnA); add(r.datasetIdB, r.columnB); }
  return m;
}

export function buildSemanticModel(datasets: ModelableDataset[], relationships: RelationshipRecord[]): SemanticModel {
  const relCols = relationshipColumns(relationships);
  const tables: SemanticTable[] = [];
  const measures: SemanticField[] = [];
  const dimensions: SemanticField[] = [];

  for (const d of datasets) {
    const alias = joinPrefix(d.name);
    const keys = new Set<string>();
    for (const c of d.columns) if (c.isUnique || relCols.get(d.id)?.has(c.name)) keys.add(c.name);
    tables.push({ datasetId: d.id, name: d.name, alias, rowCount: d.rowCount, keyColumns: Array.from(keys) });

    for (const c of d.columns) {
      const base: SemanticField = { ref: `${alias}.${c.name}`, datasetId: d.id, alias, column: c.name, type: c.type, distinctCount: c.distinctCount, examples: c.sample?.slice(0, 2), values: c.distinctValues };
      const isKey = keys.has(c.name);
      // A numeric column that is neither unique nor a join key is something
      // one adds up or averages. A unique numeric column is an identifier.
      if (c.type === "number" && !isKey) measures.push(base);
      // Anything categorical, boolean or dated slices the data. Keys are
      // offered too (a question can group "per member"), flagged so the
      // planner knows they identify rows rather than describe them.
      if (c.type !== "number" || isKey) dimensions.push({ ...base, isKey });
    }
  }

  // ── D. An id that points at another table has a readable label there ──
  // The child side of an N:1 relationship (home_branch_id → branches) can
  // be shown by the parent's first non-key text column (branch_name). Purely
  // structural: the relationship supplies the parent, the parent's own
  // profile supplies the label column.
  const aliasOf = new Map(tables.map((t) => [t.datasetId, t.alias]));
  for (const dim of dimensions) {
    if (!dim.isKey) continue;
    for (const r of relationships) {
      const childIsA = r.datasetIdA === dim.datasetId && r.columnA === dim.column && r.cardinality === "N:1";
      const childIsB = r.datasetIdB === dim.datasetId && r.columnB === dim.column && r.cardinality === "1:N";
      if (!childIsA && !childIsB) continue;
      const parent = childIsA ? r.datasetIdB : r.datasetIdA;
      const parentDs = datasets.find((d) => d.id === parent);
      // A label is text that names the row: unique per row, and not itself a
      // join key. A parent with no such column (loans have a status, not
      // a name) gets no hint rather than a misleading one.
      const label = parentDs?.columns.find((c) => c.type === "string" && c.isUnique && !relCols.get(parent)?.has(c.name));
      if (label) { dim.labelRef = `${aliasOf.get(parent)}.${label.name}`; break; }
    }
    // A table's OWN primary key: its label is the same table's text column
    // that is unique per row ("who are the top 3" wants names, not ids).
    if (!dim.labelRef) {
      const own = datasets.find((d) => d.id === dim.datasetId);
      const keyCol = own?.columns.find((c) => c.name === dim.column);
      const label = keyCol?.isUnique ? own?.columns.find((c) => c.type === "string" && c.isUnique && c.name !== dim.column && !relCols.get(dim.datasetId)?.has(c.name)) : undefined;
      if (label) dim.labelRef = `${aliasOf.get(dim.datasetId)}.${label.name}`;
    }
  }

  // Long-format detection: child value column + parent parameter column.
  const longFormats: LongFormat[] = [];
  for (const m of measures) {
    if (!GENERIC_VALUE.test(m.column)) continue;
    for (const r of relationships) {
      const childIsA = r.datasetIdA === m.datasetId && r.cardinality === "N:1";
      const childIsB = r.datasetIdB === m.datasetId && r.cardinality === "1:N";
      if (!childIsA && !childIsB) continue;
      const parentId = childIsA ? r.datasetIdB : r.datasetIdA;
      const parentDs = datasets.find((d) => d.id === parentId);
      if (!parentDs) continue;
      const unit = parentDs.columns.find((c) => UNIT_COLUMN.test(c.name));
      // A column that also joins to a lookup (a list of parameters with
      // their limits) is still the parameter column — only ids are excluded.
      const cats = parentDs.columns.filter((c) => c.type === "string" && !c.isUnique && (c.distinctCount ?? Infinity) <= 30 && (c.distinctCount ?? 0) > 1 && !UNIT_COLUMN.test(c.name) && !/(^|_)(id|code|key)$/i.test(c.name));
      const param = cats.find((c) => PARAMETER_COLUMN.test(c.name)) ?? (unit ? [...cats].sort((a, b) => (a.distinctCount ?? 0) - (b.distinctCount ?? 0))[0] : undefined);
      if (!param) continue;
      longFormats.push({
        childId: m.datasetId, valueRef: m.ref, valueColumn: m.column,
        parentId, parameterRef: `${aliasOf.get(parentId)}.${param.name}`, parameterColumn: param.name,
        parameterValues: param.distinctValues ?? [],
        unitRef: unit ? `${aliasOf.get(parentId)}.${unit.name}` : undefined,
      });
      break;
    }
  }
  const qualityFlags = dimensions
    .filter((d) => QUALITY_COLUMN.test(d.column) && (d.values?.length ?? 0) >= 2 && (d.values?.length ?? 0) <= 8)
    .map((d) => ({ datasetId: d.datasetId, ref: d.ref, column: d.column, values: d.values ?? [] }));

  return { tables, measures, dimensions, relationships, longFormats, qualityFlags };
}

/**
 * The menu as the planner sees it — compact, one line per field.
 *
 * With many uploaded files the full menu would run to hundreds of lines,
 * and a small model's accuracy falls as unrelated tables pile up in its
 * prompt. When `focusIds` is given, only those tables are listed in full;
 * the rest appear as one line each (alias + column names), still nameable
 * but no longer competing for attention.
 */
export function renderSemanticMenu(model: SemanticModel, focusIds?: Set<string>): string {
  const inFocus = (id: string) => !focusIds || focusIds.size === 0 || focusIds.has(id);
  const lines: string[] = [];
  lines.push("Tables:");
  for (const t of model.tables.filter((t) => inFocus(t.datasetId))) lines.push(`- ${t.alias} = "${t.name}" (${t.rowCount.toLocaleString()} rows; keys: ${t.keyColumns.join(", ") || "none"})`);
  const others = model.tables.filter((t) => !inFocus(t.datasetId));
  lines.push("Measures (numeric, can be summed/averaged/min/max):");
  for (const m of model.measures.filter((m) => inFocus(m.datasetId))) lines.push(`- ${m.ref}${m.examples?.length ? `  e.g. ${m.examples.join(", ")}` : ""}`);
  lines.push("Dimensions (group by / filter on; countDistinct counts their distinct values):");
  for (const d of model.dimensions.filter((d) => inFocus(d.datasetId))) {
    const tail = d.values?.length
      ? `  values: ${d.values.join(" | ")}`
      : d.examples?.length ? `  e.g. ${d.examples.join(", ")}` : "";
    const label = d.labelRef ? `  (readable name: ${d.labelRef})` : "";
    const qc = model.qualityFlags.some((q) => q.ref === d.ref) ? "  (a data-quality flag: statistics should normally be filtered to the valid value)" : "";
    lines.push(`- ${d.ref} [${d.type}${d.isKey ? ", key" : ""}${d.distinctCount != null ? `, ${d.distinctCount} distinct` : ""}]${tail}${label}${qc}`);
  }
  for (const lf of model.longFormats.filter((l) => inFocus(l.childId) || inFocus(l.parentId))) {
    lines.push(`Note: ${lf.valueRef} holds whichever quantity ${lf.parameterRef} names${lf.unitRef ? ` (units in ${lf.unitRef})` : ""}. A question about one of those quantities (${lf.parameterValues.slice(0, 6).join(", ")}${lf.parameterValues.length > 6 ? ", …" : ""}) is answered by filtering ${lf.parameterRef} to it and aggregating ${lf.valueRef} — not by aggregating another numeric column of that table.`);
  }
  if (others.length) {
    lines.push("Other tables, not shown in full because the question doesn't appear to need them (use alias.column if one does):");
    for (const t of others) {
      const cols = [...model.measures, ...model.dimensions].filter((f) => f.datasetId === t.datasetId).map((f) => f.column);
      lines.push(`- ${t.alias} = "${t.name}" (${Array.from(new Set(cols)).join(", ")})`);
    }
  }
  return lines.join("\n");
}
