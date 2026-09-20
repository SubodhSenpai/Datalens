import { ColumnSchema } from "./types";

export interface DictionaryDataset {
  id: string;
  name: string;
  columns: ColumnSchema[];
}

export interface DictionaryEntry {
  column: string;
  type: ColumnSchema["type"];
  files: { datasetId: string; datasetName: string }[];
}

// A consolidated view of every column across every uploaded file in a
// session — lets the planner (and the user, via the UI) see the full
// vocabulary it has to work with instead of one file's schema at a time,
// and surfaces which columns repeat (verbatim) across files at a glance.
export function buildDataDictionary(datasets: DictionaryDataset[]): DictionaryEntry[] {
  const map = new Map<string, DictionaryEntry>();
  for (const ds of datasets) {
    for (const col of ds.columns) {
      const key = `${col.name}::${col.type}`;
      const entry = map.get(key) ?? { column: col.name, type: col.type, files: [] };
      entry.files.push({ datasetId: ds.id, datasetName: ds.name });
      map.set(key, entry);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.column.localeCompare(b.column));
}

export interface AmbiguityWarning {
  concept: string;
  candidates: { column: string; datasetName: string }[];
}

/**
 * Just the part of a detected relationship this module needs — declared
 * structurally so the dictionary doesn't have to depend on the session store.
 */
export interface DictionaryRelationship {
  columnA: string;
  columnB: string;
}

// Words that carry no column meaning, so matching on them would flag every
// question. Purely grammatical — nothing domain-specific.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "what", "which", "who", "whom", "how",
  "many", "much", "show", "give", "list", "find", "get", "all", "any", "each", "every",
  "total", "sum", "average", "avg", "mean", "count", "number", "top", "bottom", "highest",
  "lowest", "most", "least", "per", "with", "without", "from", "that", "this", "these",
  "those", "have", "has", "had", "been", "being", "there", "their", "them", "then",
  "than", "but", "not", "did", "does", "our", "out", "across", "between", "over",
  "under", "into", "about", "compare", "versus",
]);

const tokenize = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/** "Member ID", "member_id" and "memberid" are the same name. */
const canonical = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const MAX_WARNINGS = 4;

/**
 * Flags a question whose wording points at more than one real column, so the
 * app can say which one it used instead of silently picking the first.
 *
 * Both rules below are structural — they compare the question's own words
 * against the actual column names and their profiles. There is deliberately
 * no list of business terms: a fixed vocabulary only ever covers the domain
 * it was written for, and silently stops protecting every other upload.
 */
export function detectColumnAmbiguity(
  question: string,
  datasets: DictionaryDataset[],
  relationships: DictionaryRelationship[] = []
): AmbiguityWarning[] {
  const warnings: AmbiguityWarning[] = [];
  const words = new Set(tokenize(question));

  // Column names that two of these files genuinely join on. A detected
  // relationship requires the values to actually overlap, so this is a far
  // better "is it a key?" test than uniqueness — a measure column can easily
  // be unique in every file while meaning something different in each.
  const joinKeys = new Set<string>();
  for (const r of relationships) {
    if (canonical(r.columnA) === canonical(r.columnB)) joinKeys.add(canonical(r.columnA));
  }

  // ── Rule 1: one column name, several files ───────────────────────────────
  // "amount" in orders.csv and in refunds.csv are different numbers under the
  // same name. Whichever file ends up as the join base wins the bare name, so
  // the plan can reference the wrong one without anything looking wrong.
  const byName = new Map<string, { column: string; datasetName: string }[]>();
  for (const ds of datasets) {
    for (const col of ds.columns) {
      const key = canonical(col.name);
      const list = byName.get(key) ?? [];
      list.push({ column: col.name, datasetName: ds.name });
      byName.set(key, list);
    }
  }

  for (const [key, entries] of byName) {
    if (entries.length < 2) continue;
    if (!words.has(key) && !tokenize(entries[0].column).some((w) => words.has(w))) continue;
    // A name the files actually join on is how they relate, not a choice the
    // question has to make.
    if (joinKeys.has(key)) continue;
    warnings.push({
      concept: entries[0].column,
      candidates: entries.map(({ column, datasetName }) => ({ column, datasetName })),
    });
  }

  // ── Rule 2: one word, several column names ───────────────────────────────
  // "salary" against both monthly_salary and annual_salary: each is a real
  // but different number, and the question alone cannot choose.
  for (const word of words) {
    const candidates = new Map<string, { column: string; datasetName: string }>();
    for (const ds of datasets) {
      for (const col of ds.columns) {
        if (col.type !== "number") continue;
        const name = canonical(col.name);
        // A column whose whole name IS the word is handled by Rule 1.
        if (name !== word && name.includes(word)) {
          candidates.set(name, { column: col.name, datasetName: ds.name });
        }
      }
    }
    if (candidates.size > 1) {
      warnings.push({ concept: word, candidates: Array.from(candidates.values()) });
    }
  }

  return warnings.slice(0, MAX_WARNINGS);
}
