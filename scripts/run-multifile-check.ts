/**
 * Focused live check for the multi-file join changes. Six cases only — the
 * ones whose answers depend on relationship detection, join cardinality and
 * the enriched schema sent to the planner — plus two single-file regressions
 * that must be unaffected.
 *
 * Needs the dev server on :3000. Run: npx tsx scripts/run-multifile-check.ts
 */
import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";
const DIR = path.resolve(__dirname, "../../test-data/validation");

interface Case {
  id: string;
  files: string[];
  question: string;
  expected: number;
  /** Compare against the number of rows returned rather than a cell value. */
  rowCount?: boolean;
}

const CASES: Case[] = [
  { id: "2.1  avg CTC by department (2-file join)", files: ["employees.csv", "departments.csv"],
    question: "What is the average CTC (annual_ctc) by department name?", expected: 6, rowCount: true },
  { id: "2.3  net pay Jan–Jun by dept (3-file chain)", files: ["payroll.xlsx", "employees.csv", "departments.csv"],
    question: "What is the total net pay from January to June by department name?", expected: 11121592 },
  { id: "2.10 revenue by region (derive + join)", files: ["sales_orders.csv", "regions.csv"],
    question: "What is total revenue by region name?", expected: 13769183.1 },
  { id: "2.11 revenue by product category (xlsx join)", files: ["sales_orders.csv", "products.xlsx"],
    // products.xlsx — Products carries five categories, so five rows is right.
    question: "What is total revenue by product category?", expected: 5, rowCount: true },
  { id: "1.6  derive revenue (single file)", files: ["sales_orders.csv"],
    question: "What is the total revenue across all sales orders? (revenue = quantity x unit_price x (1 - discount_pct/100))", expected: 48002573.75 },
  { id: "2.7  having + countDistinct (single file)", files: ["performance_reviews.csv"],
    question: "How many employees scored 4 or above in both performance review cycles?", expected: 15, rowCount: true },
];

async function run(c: Case) {
  const sessionId = "mf_" + Math.random().toString(36).slice(2);
  const ids: string[] = [];
  for (const f of c.files) {
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", new Blob([fs.readFileSync(path.join(DIR, f))]), f);
    const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const d = await r.json();
    if (!d.datasets?.length) { console.log(`ERROR ${c.id}: upload failed — ${d.error}`); return false; }
    for (const x of d.datasets) ids.push(x.id);
  }

  const res = await fetch(`${BASE}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, question: c.question, datasetIds: ids }),
  });
  const { result } = await res.json();
  const rows = result?.tableData?.length ?? 0;
  const nums: number[] = (result?.tableData ?? []).flatMap((r: Record<string, unknown>) =>
    Object.values(r).filter((v): v is number => typeof v === "number")
  );

  const hit = c.rowCount
    ? rows === c.expected
    : nums.some((n) => Math.abs(n - c.expected) / Math.abs(c.expected) < 0.015);

  console.log(`${hit ? "PASS" : "FAIL"}  ${c.id}`);
  console.log(`      expected ${c.expected}${c.rowCount ? " rows" : ""} | rows=${rows} nums=[${nums.slice(0, 4).join(", ")}]`);
  console.log(`      joins=${JSON.stringify(result?.source?.joins)} groupBy=${JSON.stringify(result?.source?.groupBy)}`);
  if (result?.warnings?.length) console.log(`      warnings: ${result.warnings.join(" | ")}`);
  return hit;
}

async function main() {
  let pass = 0;
  for (const c of CASES) if (await run(c)) pass++;
  console.log(`\n${pass}/${CASES.length} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
