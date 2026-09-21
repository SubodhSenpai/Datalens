/**
 * Offline regression for validator rules that can OVERRIDE a plan the model
 * got right (re-basing, join pruning, auto-include). No LLM, no server.
 *
 * Feeds the validator the exact (correct) three-file plan a model produced
 * for "which department raised the most tickets?" and checks the rule leaves
 * it alone. The rule once rebased this plan onto the 6-row departments file,
 * dropped both joins, and reported that Engineering raised 1 ticket.
 *
 * Run: npx tsx scripts/run-validator-regression.ts
 */
import fs from "fs";
import path from "path";
import { parseCSVBuffer, parseXLSXBuffer } from "../src/lib/parse";
import { detectRelationships } from "../src/lib/relationships";
import { validateAndRepairPlan } from "../src/lib/plan-validator";
import { joinRows, executeQueryPlan } from "../src/lib/query-engine";
import type { DatasetRecord } from "../src/lib/session-store";
import type { QueryPlan } from "../src/lib/types";

const DIR = path.resolve(__dirname, "../test-data/validation");
function load(file: string): DatasetRecord {
  const p = parseCSVBuffer(fs.readFileSync(path.join(DIR, file)));
  return { id: file, name: file, columns: p.columns, rows: p.rows, rowCount: p.rowCount } as DatasetRecord;
}

async function main() {
  const datasets = ["tickets_large.csv", "employees.csv", "departments.csv"].map(load);
  const rels = await detectRelationships(datasets);

  // Verbatim from the trace the model produced.
  const modelPlan: QueryPlan = {
    datasetId: "tickets_large.csv",
    joins: [
      { datasetId: "employees.csv", leftOn: "assigned_to", rightOn: "emp_id", type: "inner" },
      { datasetId: "departments.csv", on: "dept_id", type: "inner" },
    ],
    groupBy: ["dept_name"],
    aggregations: [{ column: "ticket_id", fn: "count", as: "ticket_count" }],
    sort: [{ column: "ticket_count", direction: "desc" }],
    limit: 1,
    chartType: "none",
  };

  const { plan, repairs } = validateAndRepairPlan(modelPlan, "Which department raised the most tickets?", datasets, rels);
  const rebased = repairs.filter((r) => r.field === "datasetId");

  console.log("base after validation:", plan.datasetId);
  console.log("joins after validation:", JSON.stringify(plan.joins?.map((j) => j.datasetId)));
  for (const r of repairs) console.log(`  repair [${r.field}] ${r.detail}`);

  const ok = plan.datasetId === "tickets_large.csv" && (plan.joins?.length ?? 0) === 2 && rebased.length === 0;
  console.log(`\n${ok ? "PASS" : "FAIL"}  correct three-file plan is left intact`);

  // Execute whatever came out, so the consequence is visible either way.
  const byId = new Map(datasets.map((d) => [d.id, d]));
  let rows = byId.get(plan.datasetId)!.rows!;
  for (const j of plan.joins ?? []) {
    const other = byId.get(j.datasetId)!;
    rows = joinRows(rows, other.rows!, other.name, j.leftOn ?? j.on!, j.rightOn ?? j.on!, j.type ?? "inner");
  }
  const result = executeQueryPlan(rows, plan);
  console.log("answer:", JSON.stringify(result.rows));

  // ── The case the rule exists for: wrong base, NO joins, must re-base ────
  // A model that mis-copies the base name onto an unrelated file, with no
  // join of its own, has no route to net_pay. Re-basing is the right fix
  // here (the alternative — auto-joining payroll onto the wrong base —
  // silently narrows the sum to whatever rows that base happens to hold).
  const payroll = parseXLSXBuffer(fs.readFileSync(path.join(DIR, "payroll.xlsx"))).map(
    (sh) => ({ id: `payroll.xlsx — ${sh.sheetName}`, name: `payroll.xlsx — ${sh.sheetName}`, columns: sh.columns, rows: sh.rows, rowCount: sh.rowCount }) as DatasetRecord
  );
  const ds2 = [load("employees.csv"), load("departments.csv"), ...payroll];
  const rels2 = await detectRelationships(ds2);
  const wrongBase: QueryPlan = {
    datasetId: "employees.csv",
    filters: [{ column: "month", op: "eq", value: "2025-03" }],
    aggregations: [{ column: "net_pay", fn: "sum", as: "total_net_pay" }],
    chartType: "none",
  };
  const v2 = validateAndRepairPlan(wrongBase, "What is the total net pay paid out in March 2025?", ds2, rels2);
  const ok2 = v2.plan.datasetId === "payroll.xlsx — Payroll_2025";
  console.log(`
${ok2 ? "PASS" : "FAIL"}  wrong base with no joins is still re-based (→ ${v2.plan.datasetId})`);

  // ── Unused inner joins: keep the ones that filter, drop the ones that inflate ──
  const ADV = path.resolve(__dirname, "../test-data/adversarial");
  const loadAdv = (f: string): DatasetRecord => {
    const p = parseCSVBuffer(fs.readFileSync(path.join(ADV, f)));
    return { id: f, name: f, columns: p.columns, rows: p.rows, rowCount: p.rowCount } as DatasetRecord;
  };
  const ds3 = [loadAdv("a_orders.csv"), loadAdv("a_customers.csv")];
  const rels3 = await detectRelationships(ds3);

  // orders → customers is N:1 — joining customers adds no rows; it can only
  // restrict orders to those with a known customer. The model's choice stands.
  const filterJoin: QueryPlan = {
    datasetId: "a_orders.csv",
    joins: [{ datasetId: "a_customers.csv", on: "cust_id", type: "inner" }],
    aggregations: [{ column: "order_total", fn: "sum", as: "total" }],
    chartType: "none",
  };
  const v3 = validateAndRepairPlan(filterJoin, "total of orders that have a customer record", ds3, rels3);
  const ok3 = (v3.plan.joins?.length ?? 0) === 1;
  console.log(`${ok3 ? "PASS" : "FAIL"}  unused N:1 inner join (a filter) is kept`);

  // customers → orders is 1:N — each customer row would repeat per order,
  // and nothing uses an orders column, so this one only multiplies rows.
  const inflatingJoin: QueryPlan = {
    datasetId: "a_customers.csv",
    joins: [{ datasetId: "a_orders.csv", on: "cust_id", type: "inner" }],
    aggregations: [{ column: "cust_id", fn: "count", as: "customers" }],
    chartType: "none",
  };
  const v4 = validateAndRepairPlan(inflatingJoin, "how many customers are there", ds3, rels3);
  const ok4 = (v4.plan.joins?.length ?? 0) === 0;
  console.log(`${ok4 ? "PASS" : "FAIL"}  unused 1:N inner join (inflates) is pruned`);

  if (!ok || !ok2 || !ok3 || !ok4) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
