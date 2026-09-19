/**
 * Offline regression guard for relationship detection on the REAL validation
 * files. No LLM, no server — it only exercises parse → detectRelationships.
 *
 * Its job is to prove that making key matching normalizer-based and
 * type-tolerant did not (a) lose a join path the validation questions depend
 * on, or (b) flood the planner with newly-invented ones. Both failures are
 * silent in the app itself.
 *
 * Run: npx tsx scripts/run-relationship-regression.ts
 */
import fs from "fs";
import path from "path";
import { parseCSVBuffer, parseXLSXBuffer } from "../src/lib/parse";
import { detectRelationships } from "../src/lib/relationships";
import type { DatasetRecord } from "../src/lib/session-store";

const DIR = path.resolve(__dirname, "../../test-data/validation");

function load(file: string): DatasetRecord[] {
  const buf = fs.readFileSync(path.join(DIR, file));
  if (file.toLowerCase().endsWith(".csv")) {
    const p = parseCSVBuffer(buf);
    return [{ id: file, name: file, columns: p.columns, rows: p.rows, rowCount: p.rowCount } as DatasetRecord];
  }
  return parseXLSXBuffer(buf).map(
    (s) =>
      ({
        id: `${file} — ${s.sheetName}`,
        name: `${file} — ${s.sheetName}`,
        columns: s.columns,
        rows: s.rows,
        rowCount: s.rowCount,
      }) as DatasetRecord
  );
}

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => /\.(csv|xlsx)$/i.test(f));
  const datasets = files.flatMap(load);
  const rels = await detectRelationships(datasets);

  console.log(`${files.length} files → ${datasets.length} datasets, ${rels.length} relationships\n`);

  const byCardinality = new Map<string, number>();
  for (const r of rels) {
    const k = r.cardinality ?? "unknown";
    byCardinality.set(k, (byCardinality.get(k) ?? 0) + 1);
  }
  console.log("Cardinality:", Object.fromEntries(byCardinality), "\n");

  for (const r of rels) {
    console.log(
      `  ${r.datasetIdA}.${r.columnA} ↔ ${r.datasetIdB}.${r.columnB}` +
        `  [${r.basis}, ${r.cardinality}, overlap ${r.overlapAtoB}/${r.overlapBtoA}]`
    );
  }

  // The join paths the multi-file validation questions actually traverse.
  const required: [string, string, string][] = [
    ["employees.csv", "departments.csv", "dept_id"],
    ["payroll.xlsx", "employees.csv", "emp_id"],
    ["performance_reviews.csv", "employees.csv", "emp_id"],
    ["sales_orders.csv", "regions.csv", "region_id"],
    ["sales_orders.csv", "products.xlsx", "product_id"],
    ["tickets_large.csv", "employees.csv", "emp_id"],
  ];

  console.log("\nRequired join paths:");
  let missing = 0;
  for (const [a, b, col] of required) {
    const found = rels.some(
      (r) =>
        ((r.datasetIdA.startsWith(a) && r.datasetIdB.startsWith(b)) ||
          (r.datasetIdA.startsWith(b) && r.datasetIdB.startsWith(a))) &&
        (r.columnA === col || r.columnB === col)
    );
    if (!found) missing++;
    console.log(`  ${found ? "OK  " : "MISS"} ${a} ↔ ${b} on ${col}`);
  }

  console.log(`\n${missing === 0 ? "PASS" : "FAIL"} — ${missing} required join path(s) missing`);
  if (missing > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
