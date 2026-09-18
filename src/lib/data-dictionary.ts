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

interface ConceptGroup {
  concept: string;
  term: RegExp; // matches the question
  columnPattern: RegExp; // matches candidate column names
}

// Business terms that can honestly mean more than one column, where each
// candidate is a real but DIFFERENT number — e.g. a company might track
// both a yearly headline compensation figure and a separate month-by-month
// payout figure, and "salary" could reasonably mean either. Picking either
// without saying so answers a different question than the one asked.
const CONCEPT_GROUPS: ConceptGroup[] = [
  { concept: "salary/pay", term: /\bsalary|\bsalaries\b|\bpay\b|compensation|\bwage/i, columnPattern: /ctc|salary|net_pay|gross_pay|\bbasic\b|compensation|\bwage/i },
  { concept: "revenue/amount", term: /\brevenue\b|\bsales\b(?!\s*(order|rep))|\btotal amount\b/i, columnPattern: /revenue|total_amount|sales_amount|order_value|order_amount/i },
  { concept: "cost/price", term: /\bcost\b|\bprice\b|\bexpense/i, columnPattern: /cost_price|unit_price|expense_amount|\bcost\b/i },
];

export interface AmbiguityWarning {
  concept: string;
  candidates: { column: string; datasetName: string }[];
}

// Flags when a question's generic term ("salary") could resolve to more
// than one DISTINCT column name across the datasets in scope — the
// question's wording alone can't disambiguate that, so the app should say
// which column it used rather than silently guessing one.
export function detectColumnAmbiguity(question: string, datasets: DictionaryDataset[]): AmbiguityWarning[] {
  const warnings: AmbiguityWarning[] = [];
  for (const group of CONCEPT_GROUPS) {
    if (!group.term.test(question)) continue;
    const candidates = new Map<string, { column: string; datasetName: string }>();
    for (const ds of datasets) {
      for (const col of ds.columns) {
        if (col.type === "number" && group.columnPattern.test(col.name)) {
          candidates.set(col.name.toLowerCase(), { column: col.name, datasetName: ds.name });
        }
      }
    }
    // Only flag when the candidates are genuinely different column names —
    // the same column repeated across files (a real join key) isn't ambiguous.
    if (new Set(Array.from(candidates.values()).map((c) => c.column.toLowerCase())).size > 1) {
      warnings.push({ concept: group.concept, candidates: Array.from(candidates.values()) });
    }
  }
  return warnings;
}
