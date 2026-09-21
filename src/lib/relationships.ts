import { DatasetRecord, RelationshipRecord } from "./session-store";
import { ColumnSchema } from "./types";
import { normalizeKey } from "./keys";

const VALUE_OVERLAP_THRESHOLD = 0.6;
const MIN_OVERLAP_COUNT = 2;
const SAMPLE_ROW_CAP = 2000;

/**
 * A name match is only trusted if the values actually meet. Two files can
 * easily share a header ("id", "code", "date") while describing unrelated
 * things; reporting that as a join key produced a confident, empty result.
 */
const MIN_NAME_MATCH_OVERLAP = 0.05;

/**
 * Below this many distinct values a non-unique column is a category, not a
 * key. Twenty distinct values is already more than any status/type/group
 * vocabulary and far fewer than any real identifier column.
 */
const MIN_KEY_CARDINALITY = 20;

interface ColumnProfile {
  column: ColumnSchema;
  /** Distinct normalized keys (see keys.ts) — blanks and placeholders excluded. */
  keys: Set<string>;
  /** Non-blank values present, counted with duplicates. */
  presentCount: number;
  /** Every non-blank value occurs exactly once: a candidate key. */
  unique: boolean;
}

function isFractional(p: ColumnProfile): boolean {
  if (p.column.type !== "number") return false;
  for (const k of p.keys) if (k.startsWith("n:") && k.includes(".")) return true;
  return false;
}

function profileColumn(rows: Record<string, unknown>[], column: ColumnSchema): ColumnProfile {
  const keys = new Set<string>();
  let presentCount = 0;
  const limit = Math.min(rows.length, SAMPLE_ROW_CAP);
  for (let i = 0; i < limit; i++) {
    const k = normalizeKey(rows[i][column.name]);
    if (k === null) continue;
    presentCount++;
    keys.add(k);
  }
  // The parser profiles the whole file; this loop only sees a sample, so a
  // long file could look unique here purely because its duplicates fell
  // outside the cap. Prefer the parser's answer whenever it exists.
  const unique =
    column.isUnique ?? (presentCount > 0 && keys.size === presentCount);
  return { column, keys, presentCount, unique };
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const v of smaller) if (larger.has(v)) count++;
  return count;
}

/** Same header, ignoring case and punctuation ("Member ID" ≡ "member_id"). */
const canonicalName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function cardinalityOf(aUnique: boolean, bUnique: boolean): RelationshipRecord["cardinality"] {
  if (aUnique && bUnique) return "1:1";
  if (aUnique) return "1:N";
  if (bUnique) return "N:1";
  return "N:M";
}

/**
 * Detects how uploaded files relate, by inferring primary/foreign keys the
 * way the data-profiling literature does: a candidate key on one side (every
 * value distinct) plus an inclusion dependency on the other (its values are
 * largely contained in the first).
 *
 * The previous version matched on column name + type alone. That could not
 * distinguish `members.member_id` (one row per member) from
 * `loans.member_id` (six rows per member), so every relationship looked
 * equally safe to join and a many-to-many pair silently multiplied every sum
 * it touched. Recording which side is unique is what makes fan-out
 * detectable at all.
 *
 * Two further changes matter:
 *  - Values are compared through the shared normalizer, so keys differing
 *    only by case, padding or numeric formatting still match — and, crucially,
 *    detection now agrees with what the join executor will actually do.
 *  - A name match no longer requires the two columns to share an inferred
 *    type. The same id read as a number from a spreadsheet and as text from a
 *    CSV is the single most common reason two real files refuse to join.
 */
export async function detectRelationships(datasets: DatasetRecord[]): Promise<RelationshipRecord[]> {
  const relationships: RelationshipRecord[] = [];

  // Profiled once per column rather than once per comparison — the old code
  // rebuilt both value sets inside the innermost loop.
  const profiles = new Map<string, ColumnProfile[]>();
  for (const ds of datasets) {
    if (!ds.rows) continue;
    profiles.set(
      ds.id,
      ds.columns.map((c) => profileColumn(ds.rows!, c))
    );
  }

  for (let i = 0; i < datasets.length; i++) {
    for (let j = i + 1; j < datasets.length; j++) {
      const a = datasets[i];
      const b = datasets[j];
      const profilesA = profiles.get(a.id);
      const profilesB = profiles.get(b.id);

      for (const colA of a.columns) {
        for (const colB of b.columns) {
          const sameName = canonicalName(colA.name) === canonicalName(colB.name);

          // Without rows we can only go on the header, as before.
          if (!profilesA || !profilesB) {
            if (sameName && colA.type === colB.type) {
              relationships.push({
                datasetIdA: a.id, datasetIdB: b.id,
                columnA: colA.name, columnB: colB.name,
                basis: "name", confidence: 1,
              });
            }
            continue;
          }

          const pa = profilesA.find((p) => p.column.name === colA.name)!;
          const pb = profilesB.find((p) => p.column.name === colB.name)!;
          if (pa.keys.size === 0 || pb.keys.size === 0) continue;

          // Names differ: fall back to value overlap, and keep that
          // restricted to text columns. Overlapping small integer ranges
          // (two unrelated 1..100 id columns) are a well-known false
          // positive for this technique, so a numeric join still needs the
          // names to agree.
          if (!sameName && (colA.type !== "string" || colB.type !== "string")) continue;

          const shared = intersectionSize(pa.keys, pb.keys);
          if (shared === 0) continue;

          const aInB = shared / pa.keys.size;
          const bInA = shared / pb.keys.size;
          const strongest = Math.max(aInB, bInA);

          if (sameName) {
            // A shared header with essentially no shared values is not a
            // join key — reporting it is what produced empty results.
            if (strongest < MIN_NAME_MATCH_OVERLAP) continue;
          } else if (strongest < VALUE_OVERLAP_THRESHOLD || shared < MIN_OVERLAP_COUNT) {
            continue;
          }

          // Key-ness. A join key identifies rows: at least one side holds
          // each value once, or both sides carry many distinct values. Two
          // low-cardinality columns that merely share a vocabulary (a
          // "status" or "group" with the same four values in twenty files)
          // are a category, not a relationship — and with many files such
          // pairs outnumber the real keys ten to one, poisoning every join
          // decision made from the graph.
          const looksLikeKey = pa.unique || pb.unique || (pa.keys.size >= MIN_KEY_CARDINALITY && pb.keys.size >= MIN_KEY_CARDINALITY);
          if (!looksLikeKey) continue;
          // A column holding fractional numbers is a measure (an amount, a
          // rate), never an identifier — two files sharing such values
          // (a receipt equal to its bill) is coincidence, not a key.
          if (isFractional(pa) || isFractional(pb)) continue;

          const cardinality = cardinalityOf(pa.unique, pb.unique);
          // The parent is the side holding each key once — the table the
          // other one points at. Undefined for N:M, which has no parent.
          const parentDatasetId = pa.unique && !pb.unique ? a.id
            : pb.unique && !pa.unique ? b.id
            : pa.unique && pb.unique ? a.id
            : undefined;

          relationships.push({
            datasetIdA: a.id,
            datasetIdB: b.id,
            columnA: colA.name,
            columnB: colB.name,
            basis: sameName ? "name" : "value-overlap",
            // Exact name matches keep confidence 1.0 so that downstream
            // ranking behaves exactly as it did before this change.
            confidence: sameName ? 1 : Math.round(strongest * 100) / 100,
            cardinality,
            parentDatasetId,
            overlapAtoB: Math.round(aInB * 100) / 100,
            overlapBtoA: Math.round(bInA * 100) / 100,
          });
        }
      }
    }
  }

  return relationships;
}
