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
}

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
  }

  return { tables, measures, dimensions, relationships };
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
    lines.push(`- ${d.ref} [${d.type}${d.isKey ? ", key" : ""}${d.distinctCount != null ? `, ${d.distinctCount} distinct` : ""}]${tail}${label}`);
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
