/**
 * Offline adversarial suite for the multi-file join layer.
 *
 * Deliberately contains NO LLM call, no dev server and no network: it drives
 * parse → detectRelationships → joinRows directly, so it is fast, free and
 * fully deterministic. Every fixture targets a defect that the main
 * validation set does not exercise, because that data happens to be
 * well-behaved (clean keys, consistent types, no non-key name collisions).
 *
 * Run: npx tsx scripts/run-adversarial-suite.ts
 */
import fs from "fs";
import path from "path";
import { parseCSVBuffer } from "../src/lib/parse";
import { detectRelationships } from "../src/lib/relationships";
import { joinRows } from "../src/lib/query-engine";
import { detectColumnAmbiguity } from "../src/lib/data-dictionary";
import type { DatasetRecord, RelationshipRecord } from "../src/lib/session-store";

const DIR = path.resolve(__dirname, "../test-data/adversarial");

function load(file: string): DatasetRecord {
  const parsed = parseCSVBuffer(fs.readFileSync(path.join(DIR, file)));
  return {
    id: file,
    name: file,
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
  } as DatasetRecord;
}

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    passed++;
    console.log(`PASS  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
  }
  console.log(`      ${detail}`);
}

/** The relationship linking two datasets, whichever order it was recorded in. */
function relBetween(rels: RelationshipRecord[], a: string, b: string) {
  return rels.find(
    (r) =>
      (r.datasetIdA === a && r.datasetIdB === b) || (r.datasetIdA === b && r.datasetIdB === a)
  );
}

/** Reads a field the record may not carry yet, so this file compiles either way. */
function optional<T>(obj: unknown, field: string): T | undefined {
  return (obj as Record<string, T> | undefined)?.[field];
}

async function main() {
  console.log("Adversarial join-layer suite (offline — no LLM, no server)\n");

  // ── A. Join keys that differ only by case/whitespace ────────────────────
  // relationships.ts compares values with .trim().toLowerCase(); joinRows
  // compares them raw. So a relationship is reported and the join then
  // matches nothing — a silent empty result.
  {
    const orders = load("a_orders.csv");
    const customers = load("a_customers.csv");
    const rels = await detectRelationships([orders, customers]);
    const rel = relBetween(rels, "a_orders.csv", "a_customers.csv");
    const joined = rel
      ? joinRows(orders.rows!, customers.rows!, customers.name, "cust_id", "cust_id", "inner")
      : [];
    check(
      "A. keys differing by case/whitespace still join",
      joined.length === 4,
      `relationship=${rel ? `${rel.columnA}↔${rel.columnB} (${rel.basis})` : "none"} | joined rows=${joined.length} (expected 4)`
    );
  }

  // ── B. Same key, different inferred type across files ────────────────────
  // b_stores.store_id contains an "N/A" row, so it infers as string while
  // b_sales.store_id infers as number. relationships.ts skips any pair whose
  // types differ, so the two files become entirely unjoinable.
  {
    const sales = load("b_sales.csv");
    const stores = load("b_stores.csv");
    const rels = await detectRelationships([sales, stores]);
    const rel = relBetween(rels, "b_sales.csv", "b_stores.csv");
    const salesType = sales.columns.find((c) => c.name === "store_id")?.type;
    const storesType = stores.columns.find((c) => c.name === "store_id")?.type;
    check(
      "B. same key with different inferred types is still linked",
      rel !== undefined,
      `b_sales.store_id=${salesType}, b_stores.store_id=${storesType} | relationship=${rel ? "found" : "NONE — files unjoinable"}`
    );
  }

  // ── C. A non-key column name shared by two files ─────────────────────────
  // Both files have "amount" meaning different things. A plan that says
  // "amount" silently resolves to whichever file is the base. Nothing warns.
  {
    const orders = load("c_orders.csv");
    const refunds = load("c_refunds.csv");
    const rels = await detectRelationships([orders, refunds]);
    const warnings = detectColumnAmbiguity("what is the total amount?", [orders, refunds], rels);
    const flagged = warnings.some((w) =>
      w.candidates.some((c) => c.column.toLowerCase() === "amount")
    );
    check(
      "C. a column name present in two files is flagged as ambiguous",
      flagged,
      `"amount" exists in c_orders.csv and c_refunds.csv | warnings=${JSON.stringify(warnings)}`
    );
  }

  // ── D. A genuine many-to-many pair ───────────────────────────────────────
  // E1 has 3 assignments and 2 timesheet rows, so joining on emp_id yields 6
  // rows for E1 and triples its hours. Nothing records that the join is N:M.
  {
    const assignments = load("d_assignments.csv");
    const timesheets = load("d_timesheets.csv");
    const rels = await detectRelationships([assignments, timesheets]);
    const rel = relBetween(rels, "d_assignments.csv", "d_timesheets.csv");
    const cardinality = optional<string>(rel, "cardinality");

    const trueHours = timesheets.rows!.reduce((s, r) => s + Number(r.hours), 0);
    const joined = joinRows(
      assignments.rows!,
      timesheets.rows!,
      timesheets.name,
      "emp_id",
      "emp_id",
      "inner"
    );
    const joinedHours = joined.reduce((s, r) => s + Number(r.hours), 0);

    check(
      "D. a many-to-many join is identified as N:M",
      cardinality === "N:M",
      `cardinality=${cardinality ?? "not recorded"} | true sum(hours)=${trueHours}, after join=${joinedHours} (inflated ${(joinedHours / trueHours).toFixed(1)}x)`
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
