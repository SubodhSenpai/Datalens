/**
 * Offline regression for the deterministic "can this plan answer the
 * question?" check that drives planner retries. No LLM, no server.
 *
 * Half of these are NEGATIVE cases — plans that are correct and must NOT
 * trigger a retry. A false positive here steers the model away from a right
 * answer, which is worse than no retry at all.
 *
 * Run: npx tsx scripts/run-answer-check.ts
 */
import { assessPlan, retryFeedback } from "../src/lib/answer-check";
import type { QueryPlan } from "../src/lib/types";

const cols = ["order_id", "quantity", "unit_price", "discount_pct", "emp_id", "name", "annual_ctc", "dept_name", "ticket_id", "rating"];

const cases: { label: string; question: string; plan: QueryPlan; repairs?: { field: string; detail: string }[]; expectOk: boolean }[] = [
  // ── must trigger a retry ────────────────────────────────────────────────
  { label: "total asked, rows returned (the 1.6 rerun)",
    question: "Total revenue and number of orders in sales_orders (revenue = qty × unit_price × (1 − discount%))",
    plan: { datasetId: "sales_orders.csv", select: ["order_id", "quantity", "unit_price"] }, expectOk: false },
  { label: "average by group asked, no aggregation",
    question: "What is the average rating by department name?",
    plan: { datasetId: "reviews.csv", groupBy: ["dept_name"] }, expectOk: false },
  { label: "derive the plan needed was dropped by the validator",
    question: "What is the total revenue?",
    plan: { datasetId: "sales_orders.csv", aggregations: [{ column: "revenue", fn: "sum" }] },
    repairs: [{ field: "derive", detail: 'Dropped derived column "revenue" — expression "qty * price" references a column that doesn\'t exist or isn\'t numeric.' }],
    expectOk: false },

  // ── must NOT trigger a retry ────────────────────────────────────────────
  { label: "same 1.6 question, correct plan",
    question: "Total revenue and number of orders in sales_orders (revenue = qty × unit_price × (1 − discount%))",
    plan: { datasetId: "sales_orders.csv", derive: [{ as: "revenue", expr: "quantity * unit_price * (1 - discount_pct / 100)" }],
            aggregations: [{ column: "revenue", fn: "sum", as: "total_revenue" }, { column: "order_id", fn: "count", as: "orders" }] }, expectOk: true },
  { label: "top-N rows ranking (no aggregation is correct)",
    question: "Who are the 3 highest paid employees?",
    plan: { datasetId: "employees.csv", select: ["name", "annual_ctc"], sort: [{ column: "annual_ctc", direction: "desc" }], limit: 3 }, expectOk: true },
  { label: "most-by-group with count",
    question: "Which department raised the most tickets?",
    plan: { datasetId: "tickets.csv", groupBy: ["dept_name"], aggregations: [{ column: "ticket_id", fn: "count" }], limit: 1 }, expectOk: true },
  { label: "correlation question (correlate, no aggregation)",
    question: "Is there a correlation between annual CTC and average performance rating?",
    plan: { datasetId: "employees.csv", correlate: { columnX: "annual_ctc", columnY: "rating" } }, expectOk: true },
  { label: "plain row listing",
    question: "Show all employees in Engineering",
    plan: { datasetId: "employees.csv", filters: [{ column: "dept_name", op: "eq", value: "Engineering" }] }, expectOk: true },
  { label: "cosmetic repair only (spelling) is not a drop",
    question: "How many employees are there?",
    plan: { datasetId: "employees.csv", aggregations: [{ column: "emp_id", fn: "countDistinct" }] },
    repairs: [{ field: "aggregations", detail: 'Corrected column "Emp_ID" → "emp_id".' }], expectOk: true },
];

// Rule 4: a "value/amount" answered by a bare per-unit rate with an unused
// quantity column beside it (the 1.7 failure -- "Average order value"
// answered as avg(unit_price)).
const cols2 = ["order_id", "order_date", "product_id", "region_id", "quantity", "unit_price", "discount_pct", "customer_type"];
const rateCases: { label: string; question: string; plan: QueryPlan; cols: string[]; expectOk: boolean }[] = [
  { label: "avg order value directly on unit_price (the 1.7 failure)",
    question: "Average order value",
    plan: { datasetId: "sales_orders.csv", aggregations: [{ column: "unit_price", fn: "avg", as: "avg_order_value" }] },
    cols: cols2, expectOk: false },
  { label: "total order value directly on unit_price",
    question: "What is the total order value?",
    plan: { datasetId: "sales_orders.csv", aggregations: [{ column: "unit_price", fn: "sum", as: "total_value" }] },
    cols: cols2, expectOk: false },
  { label: "correct plan: value derived from rate * quantity",
    question: "Average order value",
    plan: { datasetId: "sales_orders.csv",
            derive: [{ as: "order_value", expr: "quantity * unit_price * (1 - discount_pct / 100)" }],
            aggregations: [{ column: "order_value", fn: "avg", as: "avg_order_value" }] },
    cols: cols2, expectOk: true },
  { label: "asking for the RATE itself must not trigger (no value wording)",
    question: "What is the average unit price across all orders?",
    plan: { datasetId: "sales_orders.csv", aggregations: [{ column: "unit_price", fn: "avg", as: "avg_unit_price" }] },
    cols: cols2, expectOk: true },
  { label: "value wording but no quantity column available -- nothing to multiply by",
    question: "What is the total value?",
    plan: { datasetId: "products.xlsx", aggregations: [{ column: "unit_price", fn: "sum", as: "total" }] },
    cols: ["unit_price"], expectOk: true },
];

let bad = 0;
for (const c of cases) {
  const a = assessPlan(c.question, c.plan, c.repairs ?? [], cols);
  const ok = a.ok === c.expectOk;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}${a.ok ? "" : ` → ${a.problems.length} problem(s)`}`);
}
for (const c of rateCases) {
  const a = assessPlan(c.question, c.plan, [], c.cols);
  const ok = a.ok === c.expectOk;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}${a.ok ? "" : ` → ${a.problems[0]}`}`);
}

// "revenue"/"turnover" without a spelled-out formula (the 2.11/3.3 shape —
// "revenue by product category" never writes the formula the way 1.6 did).
const revenueCases: { label: string; question: string; plan: QueryPlan; cols: string[]; expectOk: boolean }[] = [
  { label: "revenue by category, no formula spelled out, wrong column (2.11 shape)",
    question: "What is total revenue by product category?",
    plan: { datasetId: "sales_orders.csv", groupBy: ["category"], aggregations: [{ column: "unit_price", fn: "sum", as: "revenue" }] },
    cols: cols2.concat("category"), expectOk: false },
  { label: "turnover, same shape",
    question: "What is our total turnover?",
    plan: { datasetId: "sales_orders.csv", aggregations: [{ column: "unit_price", fn: "sum", as: "turnover" }] },
    cols: cols2, expectOk: false },
  { label: "correct: revenue derived properly",
    question: "What is total revenue by product category?",
    plan: { datasetId: "sales_orders.csv", groupBy: ["category"],
            derive: [{ as: "revenue", expr: "quantity * unit_price * (1 - discount_pct / 100)" }],
            aggregations: [{ column: "revenue", fn: "sum", as: "total_revenue" }] },
    cols: cols2.concat("category"), expectOk: true },
  { label: "'sales' deliberately NOT treated as a value word (genuinely ambiguous)",
    question: "What is the average sales per region?",
    plan: { datasetId: "sales_orders.csv", groupBy: ["region_id"], aggregations: [{ column: "unit_price", fn: "avg", as: "avg_sales" }] },
    cols: cols2, expectOk: true },
];
for (const c of revenueCases) {
  const a = assessPlan(c.question, c.plan, [], c.cols);
  const ok = a.ok === c.expectOk;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}${a.ok ? "" : ` → ${a.problems[0]}`}`);
}

// The retry block must carry the previous plan, the problems and the hints.
const a0 = assessPlan(cases[0].question, cases[0].plan, [], cols);
const fb = retryFeedback(cases[0].plan, a0);
const fbOk = fb.includes(JSON.stringify(cases[0].plan)) && a0.problems.every((p) => fb.includes(p)) && a0.hints.every((h) => fb.includes(h));
if (!fbOk) bad++;
console.log(`${fbOk ? "PASS" : "FAIL"}  retry feedback includes previous plan, problems and hints`);

const total = cases.length + rateCases.length + revenueCases.length + 1;
console.log(`\n${total - bad}/${total} passed`);
process.exit(bad ? 1 : 0);
