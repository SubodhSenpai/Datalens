import { normalizeKey } from "./keys";

/**
 * Merges the results of several separately-aggregated sub-queries on their
 * leading dimension columns — the second half of multi-fact aggregation.
 * Each sub-result was grouped at the same dimensions; rows are matched by
 * the dimension VALUES (compared the way join keys are), measure columns
 * are placed side by side, and a group present in only some sub-results
 * keeps nulls for the others (a full outer join).
 *
 * With no dimensions each sub-result is a single row and the merge is just
 * their concatenation into one row: "total borrowed | total returned".
 */
export interface SubResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export function mergeAggregatedResults(parts: SubResult[], dimensionCount: number): SubResult {
  if (parts.length === 0) return { columns: [], rows: [] };
  if (parts.length === 1) return parts[0];

  // Dimension columns are named by the first part; every part's leading
  // dimensionCount columns are aligned positionally.
  const dimCols = parts[0].columns.slice(0, dimensionCount);
  const measureCols: string[] = [];
  for (const p of parts) {
    for (const c of p.columns.slice(dimensionCount)) {
      // The same alias from two parts is disambiguated by suffix.
      let name = c;
      let n = 2;
      while (measureCols.includes(name)) name = `${c}_${n++}`;
      measureCols.push(name);
    }
  }

  const keyOf = (row: Record<string, unknown>, cols: string[]) =>
    cols.map((c) => normalizeKey(row[c]) ?? "").join("\u0000");

  const merged = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  let measureOffset = 0;
  for (const p of parts) {
    const pDims = p.columns.slice(0, dimensionCount);
    const pMeasures = p.columns.slice(dimensionCount);
    for (const row of p.rows) {
      const key = keyOf(row, pDims);
      let target = merged.get(key);
      if (!target) {
        target = {};
        dimCols.forEach((c, i) => { target![c] = row[pDims[i]]; });
        for (const m of measureCols) target[m] = null;
        merged.set(key, target);
        order.push(key);
      }
      pMeasures.forEach((m, i) => { target![measureCols[measureOffset + i]] = row[m]; });
    }
    measureOffset += pMeasures.length;
  }

  return { columns: [...dimCols, ...measureCols], rows: order.map((k) => merged.get(k)!) };
}
