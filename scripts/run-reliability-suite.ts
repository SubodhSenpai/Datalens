import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// Measures ANSWER ACCURACY, not just "did it respond".
//
// Every expected value here is computed independently from the raw files by
// this script (plain reduce over parsed rows) — it never asks the app's own
// query engine what the answer is. Each question is asked REPEATEDLY, because
// the failure mode that matters with a small planner model isn't "always
// wrong", it's "right most of the time" — which only shows up across runs.
//
// Scoring is column-name agnostic on purpose: the planner names aggregation
// aliases differently run to run ("total_amount" vs "total_sales"), and that
// is cosmetic. What must be right is the NUMBER and the BREAKDOWN.

const BASE_URL = "http://localhost:3000";
const TEST_DATA = path.resolve(__dirname, "..", "..", "test-data");
const RUNS_PER_QUESTION = Number(process.env.RUNS ?? 3);
const TOLERANCE = 0.01; // 1% — guards float/rounding drift, not wrong math

// ─── Load raw data independently ────────────────────────────────────────────

function loadCSV(name: string): Record<string, string>[] {
  const text = fs.readFileSync(path.join(TEST_DATA, "csv", name), "utf-8");
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
}

function loadXLSX(name: string): Record<string, unknown>[] {
  const wb = XLSX.readFile(path.join(TEST_DATA, "xlsx", name));
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
}

const sales = loadCSV("sales_transactions.csv");
const customers = loadCSV("customers.csv");
const products = loadCSV("products.csv");
const employees = loadCSV("employees.csv");
const campaigns = loadCSV("marketing_campaigns.csv");
const hr = loadCSV("hr_attrition.csv");
const industries = loadCSV("industries_output.csv");
const environment = loadCSV("environment_emissions.csv");
const restaurants = loadXLSX("restaurant_orders.xlsx");
const hospital = loadXLSX("hospital_patients.xlsx");
const energy = loadXLSX("energy_consumption.xlsx");

const num = (v: unknown) => Number(v ?? 0);
const sum = (rows: Record<string, unknown>[], col: string) => rows.reduce((a, r) => a + num(r[col]), 0);
const avg = (rows: Record<string, unknown>[], col: string) => sum(rows, col) / rows.length;

function groupSum(rows: Record<string, unknown>[], key: string, col: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r[key]), (out.get(String(r[key])) ?? 0) + num(r[col]));
  return out;
}
function groupAvg(rows: Record<string, unknown>[], key: string, col: string): Map<string, number> {
  const totals = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    const k = String(r[key]);
    const t = totals.get(k) ?? { s: 0, n: 0 };
    t.s += num(r[col]); t.n++;
    totals.set(k, t);
  }
  return new Map(Array.from(totals, ([k, t]) => [k, t.s / t.n]));
}

// ─── Expectations ───────────────────────────────────────────────────────────

type Expectation =
  | { kind: "scalar"; value: number; label: string }
  | { kind: "grouped"; expected: Map<string, number>; label: string }
  | { kind: "groupedMulti"; expected: Map<string, number[]>; label: string }
  | { kind: "rankedRows"; keys: string[]; values: number[]; label: string }
  | { kind: "rowValues"; values: number[]; label: string };

interface Case {
  id: number;
  group: string;
  files: string[];
  question: string;
  expect: Expectation;
  /** Why this case is here — what capability it proves. */
  tests: string;
}

// Cross-file ground truth: customers ⋈ sales on customer_id, summed by tier.
const customerTierById = new Map(customers.map((c) => [String(c.customer_id), String(c.loyalty_tier)]));
const salesByTier = new Map<string, number>();
for (const s of sales) {
  const tier = customerTierById.get(String(s.customer_id));
  if (tier) salesByTier.set(tier, (salesByTier.get(tier) ?? 0) + num(s.total_amount));
}

// Cross-file with MISMATCHED key names: industries.country ⋈ environment.nation
const emissionsByNation = groupSum(environment, "nation", "co2_emissions_mt");
const outputByCountry = groupSum(industries, "country", "output_usd_billion");

// ── Ground truth for the HARD cases (the shapes that actually broke) ──

// Top 10 products by unit price — a per-row ranking, NOT an aggregate.
const topProducts = [...products]
  .sort((a, b) => num(b.unit_price) - num(a.unit_price))
  .slice(0, 10);

// Filter + groupBy combined.
const electronicsByRegion = groupSum(sales.filter((s) => s.category === "Electronics"), "region", "total_amount");

// Monthly trend for 2024 — requires date bucketing, not raw-date grouping.
const sales2024ByMonth = new Map<string, number>();
for (const s of sales) {
  const d = String(s.order_date);
  if (!d.startsWith("2024")) continue;
  const m = d.slice(0, 7);
  sales2024ByMonth.set(m, (sales2024ByMonth.get(m) ?? 0) + num(s.total_amount));
}

// Two-dimension breakdown: channel x region.
const budgetByChannelRegion = new Map<string, number>();
for (const c of campaigns) {
  const k = `${c.channel}|${c.region}`;
  budgetByChannelRegion.set(k, (budgetByChannelRegion.get(k) ?? 0) + num(c.budget_usd));
}

// Multi-metric per group: three aggregates that must ALL survive.
const socialByPlatform = new Map<string, number[]>();
{
  const social = loadXLSX("social_media_engagement.xlsx");
  const acc = new Map<string, [number, number, number]>();
  for (const r of social) {
    const k = String(r.platform);
    const cur = acc.get(k) ?? [0, 0, 0];
    acc.set(k, [cur[0] + num(r.likes), cur[1] + num(r.shares), cur[2] + num(r.comments)]);
  }
  for (const [k, v] of acc) socialByPlatform.set(k, v);
}

// Highest-average-salary department — a single correct answer.
const salaryByDept = groupAvg(employees, "department", "salary");
const topSalaryDept = Array.from(salaryByDept.entries()).reduce((a, b) => (b[1] > a[1] ? b : a));

const CASES: Case[] = [
  {
    id: 1, group: "core", files: ["sales_transactions.csv"],
    question: "What is the total sales amount across all transactions?",
    expect: { kind: "scalar", value: sum(sales, "total_amount"), label: "SUM(total_amount)" },
    tests: "scalar aggregate over 80k rows",
  },
  {
    id: 2, group: "core", files: ["products.csv"],
    question: "What is the average unit price of products?",
    expect: { kind: "scalar", value: avg(products, "unit_price"), label: "AVG(unit_price)" },
    tests: "scalar average",
  },
  {
    id: 3, group: "core", files: ["employees.csv"],
    question: "How many employees work in the Engineering department?",
    expect: { kind: "scalar", value: employees.filter((e) => e.department === "Engineering").length, label: "COUNT(dept=Engineering)" },
    tests: "filter + count",
  },
  {
    id: 4, group: "core", files: ["employees.csv"],
    question: "What is the average salary by department?",
    expect: { kind: "grouped", expected: groupAvg(employees, "department", "salary"), label: "AVG(salary) BY department" },
    tests: "groupBy + avg — the breakdown must be per-department, not one number",
  },
  {
    id: 5, group: "core", files: ["sales_transactions.csv"],
    question: "What is the total sales amount by region?",
    expect: { kind: "grouped", expected: groupSum(sales, "region", "total_amount"), label: "SUM(total_amount) BY region" },
    tests: "groupBy + sum on a large file",
  },
  {
    id: 6, group: "core", files: ["sales_transactions.csv"],
    question: "What is the total sales amount by sales channel?",
    expect: { kind: "grouped", expected: groupSum(sales, "sales_channel", "total_amount"), label: "SUM(total_amount) BY sales_channel" },
    tests: "groupBy on a different dimension of the same file",
  },
  {
    id: 7, group: "core", files: ["marketing_campaigns.csv"],
    question: "What is the total campaign budget by channel?",
    expect: { kind: "grouped", expected: groupSum(campaigns, "channel", "budget_usd"), label: "SUM(budget_usd) BY channel" },
    tests: "groupBy + sum",
  },
  {
    id: 8, group: "core", files: ["hr_attrition.csv"],
    question: "What is the average monthly income by department?",
    expect: { kind: "grouped", expected: groupAvg(hr, "department", "monthly_income"), label: "AVG(monthly_income) BY department" },
    tests: "groupBy + avg",
  },
  {
    id: 9, group: "core", files: ["customers.csv", "sales_transactions.csv"],
    question: "Combine customers with their orders and show the total order amount by loyalty tier",
    expect: { kind: "grouped", expected: salesByTier, label: "SUM(total_amount) BY loyalty_tier (cross-file join on customer_id)" },
    tests: "CROSS-FILE join on an exact-name key, then groupBy a column from the other file",
  },
  {
    id: 10, group: "macro", files: ["industries_output.csv"],
    question: "What is the total industrial output by country?",
    expect: { kind: "grouped", expected: outputByCountry, label: "SUM(output_usd_billion) BY country" },
    tests: "groupBy baseline for the cross-domain case below",
  },
  {
    id: 11, group: "macro", files: ["environment_emissions.csv"],
    question: "What are the total CO2 emissions by nation?",
    expect: { kind: "grouped", expected: emissionsByNation, label: "SUM(co2_emissions_mt) BY nation" },
    tests: "groupBy on the mismatched-name file",
  },
  {
    id: 12, group: "misc", files: ["restaurant_orders.xlsx"],
    question: "How many restaurant orders were paid by digital wallet?",
    expect: { kind: "scalar", value: restaurants.filter((r) => String(r.payment_method) === "Digital Wallet").length, label: "COUNT(payment=Digital Wallet)" },
    tests: "filter + count on XLSX",
  },
  {
    id: 13, group: "misc", files: ["restaurant_orders.xlsx"],
    question: "What is the average order value by cuisine type?",
    expect: { kind: "grouped", expected: groupAvg(restaurants, "cuisine_type", "order_value_usd"), label: "AVG(order_value_usd) BY cuisine_type" },
    tests: "groupBy + avg on XLSX",
  },
  {
    id: 14, group: "big", files: ["hospital_patients.xlsx"],
    question: "What is the average treatment cost by department?",
    expect: { kind: "grouped", expected: groupAvg(hospital, "department", "treatment_cost_usd"), label: "AVG(treatment_cost_usd) BY department" },
    tests: "groupBy + avg on XLSX",
  },
  {
    id: 15, group: "macroX", files: ["energy_consumption.xlsx"],
    question: "What is the total energy consumption by country?",
    expect: { kind: "grouped", expected: groupSum(energy, "country", "consumption_twh"), label: "SUM(consumption_twh) BY country" },
    tests: "groupBy + sum on XLSX",
  },

  // ── HARD CASES: the shapes that actually produced wrong answers before ──
  {
    id: 16, group: "core", files: ["products.csv"],
    question: "Show the top 10 products by unit price",
    expect: { kind: "rankedRows", keys: topProducts.map((p) => String(p.product_name)), values: topProducts.map((p) => num(p.unit_price)), label: "top 10 product_name rows BY unit_price (a ranking, not an aggregate)" },
    tests: "HARD: per-row ranking — previously collapsed into a single MAX value",
  },
  {
    id: 17, group: "core", files: ["sales_transactions.csv"],
    question: "What is the total sales amount by region for the Electronics category?",
    expect: { kind: "grouped", expected: electronicsByRegion, label: "SUM(total_amount) BY region WHERE category='Electronics'" },
    tests: "HARD: filter AND groupBy together — dropping either silently changes the answer",
  },
  {
    id: 18, group: "core", files: ["sales_transactions.csv"],
    question: "What is the monthly total sales amount for 2024?",
    expect: { kind: "grouped", expected: sales2024ByMonth, label: "SUM(total_amount) BY month, 2024 only" },
    tests: "HARD: date bucketing + year filter — raw-date grouping yields one row per order",
  },
  {
    id: 19, group: "core", files: ["marketing_campaigns.csv"],
    question: "What is the total campaign budget broken down by channel and region?",
    expect: { kind: "grouped", expected: budgetByChannelRegion, label: "SUM(budget_usd) BY channel x region (40 combinations)" },
    tests: "HARD: TWO groupBy dimensions — dropping one collapses the breakdown",
  },
  {
    id: 20, group: "misc", files: ["social_media_engagement.xlsx"],
    question: "Show total likes, shares and comments by platform",
    expect: { kind: "groupedMulti", expected: socialByPlatform, label: "SUM(likes), SUM(shares), SUM(comments) BY platform" },
    tests: "HARD: three aggregations must ALL survive — previously select could discard them",
  },
  {
    id: 21, group: "core", files: ["employees.csv"],
    question: "Which department has the highest average salary?",
    expect: { kind: "scalar", value: topSalaryDept[1], label: `AVG(salary) of top department (${topSalaryDept[0]})` },
    tests: "HARD: aggregate + rank + pick one — easy to answer with the wrong department",
  },
  {
    id: 22, group: "macro", files: ["industries_output.csv", "environment_emissions.csv"],
    question: "What are the total CO2 emissions by country?",
    expect: { kind: "grouped", expected: emissionsByNation, label: "SUM(co2_emissions_mt) BY nation (must NOT inflate via an unnecessary join)" },
    tests: "HARD: two files with a value-overlap relationship present, but the question needs only one — an unnecessary join multiplies every total",
  },
];

// ─── Scoring ────────────────────────────────────────────────────────────────

const close = (a: number, b: number) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (b === 0) return Math.abs(a) < 1e-6;
  return Math.abs(a - b) / Math.abs(b) <= TOLERANCE;
};

function numbersIn(row: Record<string, unknown>): number[] {
  return Object.values(row).filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
}

// A group key may be composite ("Email|North" for a channel x region
// breakdown). A correct two-dimension result returns those as SEPARATE
// columns, so match a row that carries every part of the key, not a single
// cell equal to the joined string.
function findGroupRow(tableData: Record<string, unknown>[], key: string): Record<string, unknown> | undefined {
  const parts = key.split("|").map((p) => p.trim().toLowerCase());
  return tableData.find((row) => {
    const strings = Object.values(row)
      .filter((v) => typeof v === "string")
      .map((v) => (v as string).trim().toLowerCase());
    return parts.every((p) => strings.includes(p));
  });
}

function score(expect: Expectation, tableData: Record<string, unknown>[]): { pass: boolean; reason: string } {
  if (!tableData || tableData.length === 0) return { pass: false, reason: "no rows returned" };

  if (expect.kind === "scalar") {
    const all = tableData.flatMap(numbersIn);
    const hit = all.some((n) => close(n, expect.value));
    return hit
      ? { pass: true, reason: `found ${expect.value.toFixed(2)}` }
      : { pass: false, reason: `expected ${expect.value.toFixed(2)}, got [${all.slice(0, 6).map((n) => n.toFixed(2)).join(", ")}]${tableData.length > 1 ? ` across ${tableData.length} rows` : ""}` };
  }

  if (expect.kind === "grouped") {
    const expectedKeys = Array.from(expect.expected.keys());
    if (tableData.length !== expect.expected.size) {
      return { pass: false, reason: `expected ${expect.expected.size} groups, got ${tableData.length} rows` };
    }
    let matched = 0;
    const misses: string[] = [];
    for (const [key, expectedValue] of expect.expected) {
      const row = findGroupRow(tableData, key);
      if (!row) { misses.push(`missing group "${key}"`); continue; }
      if (numbersIn(row).some((n) => close(n, expectedValue))) matched++;
      else misses.push(`"${key}" expected ${expectedValue.toFixed(2)}, got [${numbersIn(row).map((n) => n.toFixed(2)).join(", ")}]`);
    }
    return matched === expectedKeys.length
      ? { pass: true, reason: `all ${matched} groups correct` }
      : { pass: false, reason: `${matched}/${expectedKeys.length} groups correct — ${misses.slice(0, 2).join("; ")}` };
  }

  if (expect.kind === "groupedMulti") {
    if (tableData.length !== expect.expected.size) {
      return { pass: false, reason: `expected ${expect.expected.size} groups, got ${tableData.length} rows` };
    }
    const misses: string[] = [];
    let matched = 0;
    for (const [key, expectedValues] of expect.expected) {
      const row = findGroupRow(tableData, key);
      if (!row) { misses.push(`missing group "${key}"`); continue; }
      const nums = numbersIn(row);
      const allPresent = expectedValues.every((ev) => nums.some((n) => close(n, ev)));
      if (allPresent) matched++;
      else misses.push(`"${key}" missing one of [${expectedValues.map((v) => v.toFixed(0)).join(", ")}], got [${nums.map((n) => n.toFixed(0)).join(", ")}]`);
    }
    return matched === expect.expected.size
      ? { pass: true, reason: `all ${matched} groups had all metrics` }
      : { pass: false, reason: `${matched}/${expect.expected.size} groups complete — ${misses.slice(0, 2).join("; ")}` };
  }

  if (expect.kind === "rankedRows") {
    if (tableData.length !== expect.keys.length) {
      return { pass: false, reason: `expected ${expect.keys.length} ranked rows, got ${tableData.length}` };
    }
    const returnedKeys = tableData.map((r) =>
      String(Object.values(r).find((v) => typeof v === "string") ?? "").trim().toLowerCase()
    );
    const expectedKeys = expect.keys.map((k) => k.trim().toLowerCase());
    const sameSet = expectedKeys.every((k) => returnedKeys.includes(k));
    if (!sameSet) {
      const missing = expectedKeys.filter((k) => !returnedKeys.includes(k));
      return { pass: false, reason: `wrong rows — missing ${missing.slice(0, 3).join(", ")}` };
    }
    const inOrder = returnedKeys.every((k, i) => k === expectedKeys[i]);
    return inOrder
      ? { pass: true, reason: "correct rows in correct rank order" }
      : { pass: false, reason: "correct rows but wrong rank order" };
  }

  const all = tableData.flatMap(numbersIn);
  const hit = expect.values.every((v) => all.some((n) => close(n, v)));
  return hit ? { pass: true, reason: "values present" } : { pass: false, reason: "expected values missing" };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function uploadFiles(sessionId: string, files: string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const fileName of Array.from(new Set(files))) {
    const dir = fileName.endsWith(".csv") ? "csv" : "xlsx";
    const buffer = fs.readFileSync(path.join(TEST_DATA, dir, fileName));
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", new Blob([buffer]), fileName);
    const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.datasets?.length) throw new Error(`upload failed for ${fileName}: ${JSON.stringify(data)}`);
    ids.set(fileName, data.datasets[0].id);
  }
  return ids;
}

interface RunOutcome {
  pass: boolean;
  reason: string;
  chartType: string;
  repairs: number;
  ms: number;
}

async function main() {
  console.log(`Reliability suite — ${CASES.length} questions x ${RUNS_PER_QUESTION} runs each\n`);

  const results: { c: Case; runs: RunOutcome[] }[] = [];

  for (const c of CASES) {
    const runs: RunOutcome[] = [];
    for (let attempt = 1; attempt <= RUNS_PER_QUESTION; attempt++) {
      const sessionId = `rel_${c.id}_${attempt}_${Date.now()}`;
      const ids = await uploadFiles(sessionId, c.files);
      const datasetIds = Array.from(new Set(c.files)).map((f) => ids.get(f)!);

      const started = Date.now();
      const res = await fetch(`${BASE_URL}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question: c.question, datasetIds }),
      });
      const ms = Date.now() - started;
      const data = await res.json();
      const result = data.result;

      if (!result || result.status !== "success") {
        runs.push({ pass: false, reason: `query failed: ${result?.errorMessage ?? "unknown"}`, chartType: "-", repairs: 0, ms });
        continue;
      }
      const { pass, reason } = score(c.expect, result.tableData ?? []);
      runs.push({ pass, reason, chartType: result.chartType ?? "none", repairs: (result.planRepairs ?? []).length, ms });
    }

    const passes = runs.filter((r) => r.pass).length;
    const status = passes === RUNS_PER_QUESTION ? "PASS" : passes === 0 ? "FAIL" : "FLAKY";
    console.log(`[${c.id}] ${status} ${passes}/${RUNS_PER_QUESTION}  ${c.question}`);
    console.log(`     expects: ${c.expect.label}`);
    for (const r of runs) if (!r.pass) console.log(`     ✗ ${r.reason}`);
    results.push({ c, runs });
  }

  // ── Summary ──
  const totalRuns = results.length * RUNS_PER_QUESTION;
  const passedRuns = results.reduce((a, r) => a + r.runs.filter((x) => x.pass).length, 0);
  const fullyReliable = results.filter((r) => r.runs.every((x) => x.pass)).length;
  const flaky = results.filter((r) => r.runs.some((x) => x.pass) && r.runs.some((x) => !x.pass)).length;
  const alwaysWrong = results.filter((r) => r.runs.every((x) => !x.pass)).length;
  const repairsApplied = results.reduce((a, r) => a + r.runs.reduce((b, x) => b + x.repairs, 0), 0);
  const avgMs = Math.round(results.reduce((a, r) => a + r.runs.reduce((b, x) => b + x.ms, 0), 0) / totalRuns);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`ANSWER ACCURACY : ${passedRuns}/${totalRuns} runs correct (${Math.round((passedRuns / totalRuns) * 100)}%)`);
  console.log(`QUESTIONS       : ${fullyReliable} always right, ${flaky} flaky, ${alwaysWrong} always wrong (of ${results.length})`);
  console.log(`PLAN REPAIRS    : ${repairsApplied} deterministic corrections applied across ${totalRuns} runs`);
  console.log(`AVG LATENCY     : ${avgMs}ms`);
  console.log(`${"=".repeat(60)}`);

  fs.writeFileSync(
    path.join(TEST_DATA, "reliability-report.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: process.env.OPENROUTER_MODEL ?? "(default)",
        runsPerQuestion: RUNS_PER_QUESTION,
        accuracy: { passedRuns, totalRuns, pct: Math.round((passedRuns / totalRuns) * 100) },
        questions: { fullyReliable, flaky, alwaysWrong, total: results.length },
        cases: results.map(({ c, runs }) => ({
          id: c.id, question: c.question, tests: c.tests, expects: c.expect.label,
          passes: runs.filter((r) => r.pass).length, runs,
        })),
      },
      null,
      2
    )
  );
  console.log(`\nDetail written to test-data/reliability-report.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
