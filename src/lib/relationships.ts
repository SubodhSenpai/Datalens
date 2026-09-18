import { DatasetRecord, RelationshipRecord } from "./session-store";

const VALUE_OVERLAP_THRESHOLD = 0.6;
const MIN_OVERLAP_COUNT = 2;
const SAMPLE_ROW_CAP = 2000;

function distinctValues(rows: Record<string, unknown>[], column: string): Set<string> {
  const set = new Set<string>();
  for (const row of rows.slice(0, SAMPLE_ROW_CAP)) {
    const v = row[column];
    if (v === null || v === undefined || v === "") continue;
    set.add(String(v).trim().toLowerCase());
  }
  return set;
}

function overlapRatio(a: Set<string>, b: Set<string>): { ratio: number; count: number } {
  if (a.size === 0 || b.size === 0) return { ratio: 0, count: 0 };
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const v of smaller) if (larger.has(v)) count++;
  return { ratio: count / smaller.size, count };
}

/**
 * Detects likely join keys between datasets two ways:
 *  1. Exact column name + type match (confidence 1.0) — cheap, catches the
 *     common case where both files use the same header.
 *  2. Value-overlap matching for same-typed string columns whose names
 *     DON'T match (e.g. "country" vs "nation") — the actual values are
 *     compared, and a relationship is only recorded when a large share of
 *     one column's distinct values also appear in the other. This is what
 *     makes real cross-domain joins ("industries.csv" + "environment.csv"
 *     with differently-named location columns) discoverable at all; without
 *     it, only files that happen to share exact header names could ever be
 *     joined.
 * Numeric columns are excluded from value-overlap matching — overlapping
 * small integer ranges (e.g. two unrelated ID columns) are a well-known
 * false-positive risk for this technique, so numeric joins require an exact
 * name match.
 */
export async function detectRelationships(datasets: DatasetRecord[]): Promise<RelationshipRecord[]> {
  const relationships: RelationshipRecord[] = [];

  for (let i = 0; i < datasets.length; i++) {
    for (let j = i + 1; j < datasets.length; j++) {
      const a = datasets[i];
      const b = datasets[j];

      for (const colA of a.columns) {
        for (const colB of b.columns) {
          if (colA.type !== colB.type) continue;

          if (colA.name.toLowerCase() === colB.name.toLowerCase()) {
            relationships.push({
              datasetIdA: a.id,
              datasetIdB: b.id,
              columnA: colA.name,
              columnB: colB.name,
              basis: "name",
              confidence: 1,
            });
            continue;
          }

          if (colA.type !== "string" || !a.rows || !b.rows) continue;

          const setA = distinctValues(a.rows, colA.name);
          const setB = distinctValues(b.rows, colB.name);
          const { ratio, count } = overlapRatio(setA, setB);
          if (ratio >= VALUE_OVERLAP_THRESHOLD && count >= MIN_OVERLAP_COUNT) {
            relationships.push({
              datasetIdA: a.id,
              datasetIdB: b.id,
              columnA: colA.name,
              columnB: colB.name,
              basis: "value-overlap",
              confidence: Math.round(ratio * 100) / 100,
            });
          }
        }
      }
    }
  }

  return relationships;
}
