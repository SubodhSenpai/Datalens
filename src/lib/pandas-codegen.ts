import { QueryPlan } from "./types";

export interface PandasDatasetName {
  id: string;
  name: string;
}

function varName(fileName: string): string {
  const base = fileName
    .replace(/\.(csv|xlsx|xls)$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[a-z]/.test(base) ? base : `df_${base}`;
}

function quote(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

const OP_TO_PANDAS: Record<string, string> = {
  eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=",
};

// The engine's aggregate names are its own; pandas spells the mean
// differently. Emitting "avg" here would print code that raises at runtime,
// which defeats the point of showing it.
const AGG_TO_PANDAS: Record<string, string> = {
  sum: "sum", avg: "mean", count: "count", countDistinct: "nunique", min: "min", max: "max",
};

/**
 * Renders the executed QueryPlan as the equivalent pandas code.
 *
 * This is a FAITHFUL rendering of what the deterministic engine actually did
 * (same order of operations: load → join → derive → filter → bucket →
 * group/aggregate → sort → limit), not an idealized version — so if the
 * generated code looks wrong, the answer above it is wrong the same way.
 * It is for reading, not executing: the engine runs its own TypeScript
 * implementation, this just makes that legible to anyone who knows pandas.
 */
export function planToPandas(plan: QueryPlan, datasets: PandasDatasetName[]): string {
  const nameById = new Map(datasets.map((d) => [d.id, d.name]));
  const baseName = nameById.get(plan.datasetId) ?? "dataset";
  const base = varName(baseName);
  const lines: string[] = ["import pandas as pd", ""];

  lines.push(`${base} = pd.${baseName.match(/\.xlsx?$/i) ? "read_excel" : "read_csv"}(${quote(baseName)})`);

  for (const join of plan.joins ?? []) {
    const otherName = nameById.get(join.datasetId) ?? join.datasetId;
    const other = varName(otherName);
    const leftOn = join.leftOn ?? join.on;
    const rightOn = join.rightOn ?? join.on;
    lines.push(`${other} = pd.${otherName.match(/\.xlsx?$/i) ? "read_excel" : "read_csv"}(${quote(otherName)})`);
    lines.push(
      `${base} = ${base}.merge(${other}, left_on=${quote(leftOn ?? "")}, right_on=${quote(rightOn ?? "")}, how=${quote(join.type ?? "inner")})`
    );
  }

  const hasRowOps = (plan.derive?.length ?? 0) > 0 || (plan.filters?.length ?? 0) > 0 || !!plan.dateBucket;
  if (hasRowOps) lines.push("");

  for (const d of plan.derive ?? []) {
    // The engine's expression grammar (+ - * / parens, column names) is
    // already valid pandas vector arithmetic, so it maps over directly.
    const expr = d.expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (ident) => `${base}[${quote(ident)}]`);
    lines.push(`${base}[${quote(d.as)}] = ${expr}`);
  }

  for (const f of plan.filters ?? []) {
    if (f.op === "in" || f.op === "notIn") {
      const list = (Array.isArray(f.value) ? f.value : [f.value]).map((v) => (typeof v === "number" ? String(v) : quote(String(v)))).join(", ");
      lines.push(`${base} = ${base}[${f.op === "notIn" ? "~" : ""}${base}[${quote(f.column)}].isin([${list}])]`);
    } else if (f.op === "isNull") {
      lines.push(`${base} = ${base}[${base}[${quote(f.column)}].isna()]`);
    } else if (f.op === "isNotNull") {
      lines.push(`${base} = ${base}[${base}[${quote(f.column)}].notna()]`);
    } else if (f.op === "contains") {
      lines.push(`${base} = ${base}[${base}[${quote(f.column)}].astype(str).str.contains(${quote(String(f.value))}, case=False, na=False)]`);
    } else {
      lines.push(`${base} = ${base}[${base}[${quote(f.column)}] ${OP_TO_PANDAS[f.op] ?? "=="} ${quote(Array.isArray(f.value) ? f.value.join(",") : f.value)}]`);
    }
  }

  if (plan.dateBucket) {
    const alias = plan.dateBucket.as ?? `${plan.dateBucket.column}_${plan.dateBucket.granularity}`;
    const fmt = plan.dateBucket.granularity === "year" ? "%Y" : plan.dateBucket.granularity === "month" ? "%Y-%m" : "%Y-%m-%d";
    lines.push(
      `${base}[${quote(alias)}] = pd.to_datetime(${base}[${quote(plan.dateBucket.column)}]).dt.strftime(${quote(fmt)})`
    );
  }

  const hasGroup = Boolean(plan.groupBy?.length);
  const hasAgg = Boolean(plan.aggregations?.length);
  let result = base;

  if (hasGroup || hasAgg) {
    const aggPairs = (plan.aggregations ?? []).map(
      (a) => `    ${a.as ?? `${a.fn}_${a.column}`}=(${quote(a.column)}, ${quote(AGG_TO_PANDAS[a.fn] ?? a.fn)}),`
    );
    if (hasGroup) {
      const keys = plan.groupBy!.map(quote).join(", ");
      const by = plan.groupBy!.length === 1 ? keys : `[${keys}]`;
      if (aggPairs.length > 0) {
        lines.push("", `result = (${base}`, `  .groupby(${by}, as_index=False)`, "  .agg(", ...aggPairs, "  ))");
      } else {
        lines.push("", `result = ${base}.groupby(${by}, as_index=False).size().rename(columns={"size": "count"})`);
      }
    } else {
      // Aggregations with no groupBy collapse everything to one summary row.
      const items = (plan.aggregations ?? [])
        .map((a) => `  ${quote(a.as ?? `${a.fn}_${a.column}`)}: [${base}[${quote(a.column)}].${AGG_TO_PANDAS[a.fn] ?? a.fn}()],`);
      lines.push("", "result = pd.DataFrame({", ...items, "})");
    }
    for (const h of plan.having ?? []) {
      if (h.op === "in" || h.op === "notIn") {
        const list = (Array.isArray(h.value) ? h.value : [h.value]).map((v) => (typeof v === "number" ? String(v) : quote(String(v)))).join(", ");
        lines.push(`result = result[${h.op === "notIn" ? "~" : ""}result[${quote(h.column)}].isin([${list}])]`);
      } else if (h.op === "isNull") {
        lines.push(`result = result[result[${quote(h.column)}].isna()]`);
      } else if (h.op === "isNotNull") {
        lines.push(`result = result[result[${quote(h.column)}].notna()]`);
      } else if (h.op === "contains") {
        lines.push(`result = result[result[${quote(h.column)}].astype(str).str.contains(${quote(String(h.value))}, case=False, na=False)]`);
      } else {
        lines.push(`result = result[result[${quote(h.column)}] ${OP_TO_PANDAS[h.op] ?? "=="} ${quote(Array.isArray(h.value) ? h.value.join(",") : h.value)}]`);
      }
    }
    result = "result";
  } else if (plan.select?.length) {
    lines.push("", `result = ${base}[[${plan.select.map(quote).join(", ")}]]`);
    result = "result";
  } else {
    lines.push("", `result = ${base}`);
    result = "result";
  }

  if (plan.sort?.length) {
    const cols = plan.sort.map((s) => quote(s.column)).join(", ");
    const asc = plan.sort.map((s) => (s.direction === "asc" ? "True" : "False")).join(", ");
    lines.push(
      plan.sort.length === 1
        ? `${result} = ${result}.sort_values(${cols}, ascending=${asc})`
        : `${result} = ${result}.sort_values([${cols}], ascending=[${asc}])`
    );
  }

  if (typeof plan.limit === "number" && plan.limit > 0) {
    lines.push(`${result} = ${result}.head(${plan.limit})`);
  }

  if (plan.correlate) {
    lines.push(
      "",
      `# Pearson correlation, computed on the filtered rows (not the grouped result)`,
      `r = ${base}[${quote(plan.correlate.columnX)}].corr(${base}[${quote(plan.correlate.columnY)}])`
    );
  }

  return lines.join("\n");
}
