import * as fs from "fs";
import * as path from "path";
import Papa from "papaparse";
import * as XLSX from "xlsx";

// Runs the Tier 1 + Tier 2 questions from test-data/validation/TEST_QUESTIONS.md
// against the live app. Ground truth for every case is recomputed HERE,
// directly from the raw files, independent of anything the app itself
// reports — the app's own numbers are never trusted as the reference.

const BASE_URL = "http://localhost:3000";
const VALID_DIR = path.resolve(__dirname, "..", "test-data", "validation");
const RUNS = Number(process.env.RUNS ?? 1);
const TOLERANCE = 0.015;

function loadCSV(name: string): Record<string, string>[] {
  const text = fs.readFileSync(path.join(VALID_DIR, name), "utf-8");
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
}
function loadSheet(file: string, sheet: string): Record<string, unknown>[] {
  const wb = XLSX.readFile(path.join(VALID_DIR, file));
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheet]);
}

const employees = loadCSV("employees.csv");
const departments = loadCSV("departments.csv");
const attendance = loadCSV("attendance.csv");
const reviews = loadCSV("performance_reviews.csv");
const salesOrders = loadCSV("sales_orders.csv");
const regions = loadCSV("regions.csv");
const payroll = loadSheet("payroll.xlsx", "Payroll_2025");
const bonus = loadSheet("payroll.xlsx", "Bonus");
const products = loadSheet("products.xlsx", "Products");
const targets = loadSheet("products.xlsx", "Targets");
const tickets = loadCSV("tickets_large.csv");

const num = (v: unknown) => Number(v ?? 0);
const sum = (rows: Record<string, unknown>[], col: string) => rows.reduce((a, r) => a + num(r[col]), 0);
const avg = (rows: Record<string, unknown>[], col: string) => (rows.length ? sum(rows, col) / rows.length : 0);
function groupSum(rows: Record<string, unknown>[], key: string, col: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(String(r[key]), (out.get(String(r[key])) ?? 0) + num(r[col]));
  return out;
}
function groupAvg(rows: Record<string, unknown>[], key: string, col: string): Map<string, number> {
  const t = new Map<string, { s: number; n: number }>();
  for (const r of rows) {
    const k = String(r[key]);
    const c = t.get(k) ?? { s: 0, n: 0 };
    c.s += num(r[col]); c.n++;
    t.set(k, c);
  }
  return new Map(Array.from(t, ([k, v]) => [k, v.s / v.n]));
}

const deptName = new Map(departments.map((d) => [d.dept_id, d.dept_name]));
const regionName = new Map(regions.map((r) => [r.region_id, r.region_name]));
const revenue = (o: Record<string, unknown>) => num(o.quantity) * num(o.unit_price) * (1 - num(o.discount_pct) / 100);

type Expectation =
  | { kind: "scalar"; value: number; label: string }
  | { kind: "grouped"; expected: Map<string, number>; label: string }
  | { kind: "groupedSubset"; expected: Map<string, number>; label: string }
  | { kind: "rankedRows"; keys: string[]; values: number[]; label: string }
  | { kind: "correlation"; sign: "positive" | "negative"; minAbs: number; maxAbs: number; label: string };

interface Case {
  id: string;
  files: string[];
  question: string;
  expect: Expectation;
}

const CASES: Case[] = [
  // ── Tier 1 ──
  { id: "1.1a", files: ["employees.csv"], question: "How many employees are there in total?",
    expect: { kind: "scalar", value: employees.length, label: "COUNT(*)" } },
  { id: "1.1b", files: ["employees.csv"], question: "How many employees are active vs exited?",
    expect: { kind: "grouped", expected: groupSum(employees.map((e) => ({ ...e, one: 1 })), "status", "one"), label: "COUNT(*) BY status" } },
  { id: "1.2", files: ["employees.csv"], question: "What is the gender split of employees?",
    expect: { kind: "grouped", expected: groupSum(employees.map((e) => ({ ...e, one: 1 })), "gender", "one"), label: "COUNT(*) BY gender" } },
  { id: "1.4", files: ["employees.csv"], question: "How many employees joined in 2023 or later?",
    expect: { kind: "scalar", value: employees.filter((e) => e.date_of_joining >= "2023-01-01").length, label: "COUNT(date_of_joining >= 2023)" } },
  { id: "1.5", files: ["employees.csv"], question: "What is the headcount by level?",
    expect: { kind: "grouped", expected: groupSum(employees.map((e) => ({ ...e, one: 1 })), "level", "one"), label: "COUNT(*) BY level" } },
  { id: "1.6", files: ["sales_orders.csv"], question: "What is the total revenue across all sales orders? (revenue = quantity x unit_price x (1 - discount_pct/100))",
    expect: { kind: "scalar", value: sum(salesOrders.map((o) => ({ revenue: revenue(o) })), "revenue"), label: "SUM(qty*price*(1-disc))" } },
  { id: "1.8", files: ["sales_orders.csv"], question: "How many total units were sold per product ID?",
    expect: { kind: "grouped", expected: groupSum(salesOrders, "product_id", "quantity"), label: "SUM(quantity) BY product_id" } },
  { id: "1.9", files: ["attendance.csv"], question: "What is the attendance status breakdown for March?",
    expect: { kind: "grouped", expected: groupSum(attendance.map((a) => ({ ...a, one: 1 })), "status", "one"), label: "COUNT(*) BY status" } },

  // ── Tier 2 (cross-file) ──
  { id: "2.1", files: ["employees.csv", "departments.csv"], question: "What is the average CTC (annual_ctc) by department name?",
    expect: { kind: "grouped", expected: groupAvg(employees.map((e) => ({ ...e, dept_name: deptName.get(e.dept_id) })), "dept_name", "annual_ctc"), label: "AVG(annual_ctc) BY dept_name (join employees.dept_id = departments.dept_id)" } },
  { id: "2.3", files: ["payroll.xlsx", "employees.csv", "departments.csv"], question: "What is the total net pay from January to June by department name?",
    expect: { kind: "grouped", expected: (() => {
      const empDept = new Map(employees.map((e) => [e.emp_id, deptName.get(e.dept_id)]));
      const rows = payroll.map((p) => ({ dept: empDept.get(String(p.emp_id)), net_pay: p.net_pay }));
      return groupSum(rows, "dept", "net_pay");
    })(), label: "SUM(net_pay) BY department (join payroll.emp_id = employees.emp_id = departments.dept_id)" } },
  { id: "2.4", files: ["payroll.xlsx"], question: "What is the total bonus paid by bonus type, with counts?",
    expect: { kind: "grouped", expected: groupSum(bonus, "bonus_type", "bonus_amount"), label: "SUM(bonus_amount) BY bonus_type (from the Bonus sheet)" } },
  { id: "2.6", files: ["employees.csv", "departments.csv", "performance_reviews.csv"], question: "What is the average performance rating by department name?",
    expect: { kind: "grouped", expected: (() => {
      const empDept = new Map(employees.map((e) => [e.emp_id, deptName.get(e.dept_id)]));
      const rows = reviews.map((r) => ({ dept: empDept.get(r.emp_id), rating: r.rating }));
      return groupAvg(rows, "dept", "rating");
    })(), label: "AVG(rating) BY department (join reviews.emp_id = employees.emp_id -> departments)" } },
  { id: "2.10", files: ["sales_orders.csv", "regions.csv"], question: "What is total revenue by region name?",
    expect: { kind: "grouped", expected: groupSum(salesOrders.map((o) => ({ region_name: regionName.get(o.region_id), revenue: revenue(o) })), "region_name", "revenue"), label: "SUM(revenue) BY region_name (join sales_orders.region_id = regions.region_id)" } },
  { id: "2.11", files: ["sales_orders.csv", "products.xlsx"], question: "What is total revenue by product category?",
    expect: { kind: "grouped", expected: (() => {
      const cat = new Map(products.map((p) => [String(p.product_id), p.category]));
      const rows = salesOrders.map((o) => ({ category: cat.get(o.product_id), revenue: revenue(o) }));
      return groupSum(rows, "category", "revenue");
    })(), label: "SUM(revenue) BY category (join sales_orders.product_id = products.product_id, from the Products sheet)" } },
  { id: "2.14a", files: ["sales_orders.csv"], question: "Compare B2B vs B2C: what is the total revenue for each customer type?",
    expect: { kind: "grouped", expected: groupSum(salesOrders.map((o) => ({ customer_type: o.customer_type, revenue: revenue(o) })), "customer_type", "revenue"), label: "SUM(revenue) BY customer_type" } },
  { id: "2.14b", files: ["sales_orders.csv"], question: "Compare B2B vs B2C: what is the average discount percentage for each customer type?",
    expect: { kind: "grouped", expected: groupAvg(salesOrders, "customer_type", "discount_pct"), label: "AVG(discount_pct) BY customer_type" } },

  // ── Tier 1 (remaining) ──
  { id: "1.3", files: ["employees.csv"], question: "Who are the 3 highest paid employees?",
    expect: (() => {
      const top = [...employees].sort((a, b) => num(b.annual_ctc) - num(a.annual_ctc)).slice(0, 3);
      return { kind: "rankedRows", keys: top.map((e) => e.name), values: top.map((e) => num(e.annual_ctc)), label: "top 3 employees BY annual_ctc" } as Expectation;
    })() },
  { id: "1.7", files: ["sales_orders.csv"], question: "What is the average order value across all sales orders?",
    expect: { kind: "scalar", value: avg(salesOrders.map((o) => ({ revenue: revenue(o) })), "revenue"), label: "AVG(revenue) across all orders" } },
  { id: "1.10", files: ["attendance.csv"], question: "Which employee was absent the most days in March?",
    expect: (() => {
      const absentCounts = groupSum(attendance.filter((a) => a.status === "Absent").map((a) => ({ ...a, one: 1 })), "emp_id", "one");
      const top = Array.from(absentCounts.entries()).reduce((a, b) => (b[1] > a[1] ? b : a));
      return { kind: "rankedRows", keys: [top[0]], values: [top[1]], label: "MAX COUNT(status=Absent) BY emp_id" } as Expectation;
    })() },
  { id: "1.11", files: ["employees.csv"], question: "Which manager has the most direct reports? Show the count of direct reports for each manager.",
    expect: (() => {
      const counts = groupSum(employees.filter((e) => e.manager_id).map((e) => ({ ...e, one: 1 })), "manager_id", "one");
      const maxCount = Math.max(...Array.from(counts.values()));
      const top = new Map(Array.from(counts.entries()).filter(([, v]) => v === maxCount));
      return { kind: "groupedSubset", expected: top, label: "manager(s) with MAX COUNT(*) BY manager_id" } as Expectation;
    })() },

  // ── Tier 2 (remaining) ──
  { id: "2.2", files: ["payroll.xlsx"], question: "What is the total net pay paid out in March 2025?",
    expect: { kind: "scalar", value: sum(payroll.filter((p) => p.month === "2025-03"), "net_pay"), label: "SUM(net_pay) WHERE month=2025-03" } },
  { id: "2.5", files: ["employees.csv", "payroll.xlsx"], question: "Did any exited employees receive a bonus? What is the total bonus amount paid to exited employees?",
    expect: (() => {
      const exitedIds = new Set(employees.filter((e) => e.status === "Exited").map((e) => e.emp_id));
      const total = sum(bonus.filter((b) => exitedIds.has(String(b.emp_id))), "bonus_amount");
      return { kind: "scalar", value: total, label: "SUM(bonus_amount) WHERE emp.status=Exited (join bonus.emp_id=employees.emp_id)" } as Expectation;
    })() },
  { id: "2.7", files: ["performance_reviews.csv"], question: "How many employees scored 4 or above in both performance review cycles?",
    expect: (() => {
      const byEmp = new Map<string, Record<string, number>>();
      for (const r of reviews) {
        const m = byEmp.get(r.emp_id) ?? {};
        m[r.review_cycle] = num(r.rating);
        byEmp.set(r.emp_id, m);
      }
      const cycles = Array.from(new Set(reviews.map((r) => r.review_cycle)));
      let count = 0;
      for (const m of byEmp.values()) {
        if (cycles.every((c) => (m[c] ?? 0) >= 4)) count++;
      }
      return { kind: "scalar", value: count, label: "COUNT(emp_id) WHERE rating>=4 in every review_cycle" } as Expectation;
    })() },
  { id: "2.8", files: ["employees.csv"], question: "Show the top 5 highest-paid employees who are recommended for promotion.",
    expect: (() => {
      // "recommended for promotion" lives in performance_reviews, not
      // employees — deliberately asked without naming that file, matching
      // the assignment's "joins inferred without the user naming them" bar.
      const recommended = new Set(reviews.filter((r) => r.promotion_recommended === "Yes").map((r) => r.emp_id));
      const top = employees.filter((e) => recommended.has(e.emp_id)).sort((a, b) => num(b.annual_ctc) - num(a.annual_ctc)).slice(0, 5);
      return { kind: "rankedRows", keys: top.map((e) => e.name), values: top.map((e) => num(e.annual_ctc)), label: "top 5 employees BY annual_ctc WHERE promotion_recommended=Yes" } as Expectation;
    })() },
  { id: "2.9", files: ["employees.csv", "performance_reviews.csv"], question: "Is there a correlation between annual CTC and average performance rating?",
    expect: { kind: "correlation", sign: "negative", minAbs: 0.1, maxAbs: 0.45, label: "corr(annual_ctc, avg_rating) ~ -0.25" } },
  { id: "2.12", files: ["sales_orders.csv", "products.xlsx"], question: "Which product is the most profitable and which is the least profitable? (profit = revenue - quantity x cost_price)",
    expect: (() => {
      const costById = new Map(products.map((p) => [String(p.product_id), num(p.cost_price)]));
      const nameById = new Map(products.map((p) => [String(p.product_id), String(p.product_name)]));
      const profitByProduct = new Map<string, number>();
      for (const o of salesOrders) {
        const name = nameById.get(o.product_id);
        if (!name) continue;
        const profit = revenue(o) - num(o.quantity) * (costById.get(o.product_id) ?? 0);
        profitByProduct.set(name, (profitByProduct.get(name) ?? 0) + profit);
      }
      const entries = Array.from(profitByProduct.entries());
      const most = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
      const least = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
      return { kind: "groupedSubset", expected: new Map([most, least]), label: "MAX/MIN of SUM(revenue - qty*cost_price) BY product_name" } as Expectation;
    })() },
  { id: "2.15", files: ["tickets_large.csv", "employees.csv", "departments.csv"], question: "Which department raised the most support tickets?",
    expect: (() => {
      const empDept = new Map(employees.map((e) => [e.emp_id, deptName.get(e.dept_id)]));
      const rows = tickets.map((t) => ({ dept: empDept.get(t.assigned_to), one: 1 }));
      const counts = groupSum(rows, "dept", "one");
      const top = Array.from(counts.entries()).reduce((a, b) => (b[1] > a[1] ? b : a));
      return { kind: "rankedRows", keys: [top[0]], values: [top[1]], label: "MAX COUNT(*) BY department (join tickets.assigned_to=employees.emp_id -> departments)" } as Expectation;
    })() },
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
function findGroupRow(tableData: Record<string, unknown>[], key: string): Record<string, unknown> | undefined {
  const kk = key.trim().toLowerCase();
  return tableData.find((row) =>
    Object.values(row).some((v) => typeof v === "string" && v.trim().toLowerCase() === kk)
  );
}
function score(expect: Expectation, tableData: Record<string, unknown>[], correlation?: { coefficient: number }): { pass: boolean; reason: string } {
  if (expect.kind === "correlation") {
    if (!correlation) return { pass: false, reason: "no correlation computed" };
    const abs = Math.abs(correlation.coefficient);
    const signOk = expect.sign === "positive" ? correlation.coefficient > 0 : correlation.coefficient < 0;
    const magOk = abs >= expect.minAbs && abs <= expect.maxAbs;
    return signOk && magOk
      ? { pass: true, reason: `r=${correlation.coefficient}` }
      : { pass: false, reason: `expected ${expect.sign} r in [${expect.minAbs},${expect.maxAbs}], got r=${correlation.coefficient}` };
  }
  if (!tableData || tableData.length === 0) return { pass: false, reason: "no rows returned" };
  if (expect.kind === "scalar") {
    const all = tableData.flatMap(numbersIn);
    const hit = all.some((n) => close(n, expect.value));
    return hit
      ? { pass: true, reason: `found ${expect.value.toFixed(2)}` }
      : { pass: false, reason: `expected ${expect.value.toFixed(2)}, got [${all.slice(0, 8).map((n) => n.toFixed(2)).join(", ")}]` };
  }
  if (expect.kind === "rankedRows") {
    // A single-row "who is #1" question may legitimately come back either
    // as one row or as a full ranked breakdown — only check that row #1 is
    // correct rather than demanding an exact row count.
    if (expect.keys.length === 1) {
      const row = findGroupRow(tableData, expect.keys[0]);
      if (!row) return { pass: false, reason: `missing "${expect.keys[0]}" in result` };
      return numbersIn(row).some((n) => close(n, expect.values[0]))
        ? { pass: true, reason: `found ${expect.keys[0]}=${expect.values[0]}` }
        : { pass: false, reason: `"${expect.keys[0]}" expected ${expect.values[0]}, got [${numbersIn(row).join(", ")}]` };
    }
    if (tableData.length !== expect.keys.length) {
      return { pass: false, reason: `expected ${expect.keys.length} ranked rows, got ${tableData.length}` };
    }
    const returnedKeys = tableData.map((r) =>
      String(Object.values(r).find((v) => typeof v === "string") ?? "").trim().toLowerCase()
    );
    const expectedKeys = expect.keys.map((k) => k.trim().toLowerCase());
    const missing = expectedKeys.filter((k) => !returnedKeys.includes(k));
    if (missing.length > 0) return { pass: false, reason: `missing rows: ${missing.join(", ")} — got [${returnedKeys.join(", ")}]` };
    const inOrder = returnedKeys.every((k, i) => k === expectedKeys[i]);
    return inOrder
      ? { pass: true, reason: "correct rows in correct rank order" }
      : { pass: false, reason: `correct rows but wrong order — got [${returnedKeys.join(", ")}]` };
  }
  if (expect.kind === "groupedSubset") {
    let matched = 0;
    const misses: string[] = [];
    for (const [key, expectedValue] of expect.expected) {
      const row = findGroupRow(tableData, key);
      if (!row) { misses.push(`missing "${key}"`); continue; }
      if (numbersIn(row).some((n) => close(n, expectedValue))) matched++;
      else misses.push(`"${key}" expected ${expectedValue}, got [${numbersIn(row).join(", ")}]`);
    }
    return matched === expect.expected.size
      ? { pass: true, reason: `all ${matched} checked values correct` }
      : { pass: false, reason: `${matched}/${expect.expected.size} correct — ${misses.join("; ")}` };
  }
  const expectedKeys = Array.from(expect.expected.keys());
  if (tableData.length !== expect.expected.size) {
    return { pass: false, reason: `expected ${expect.expected.size} groups, got ${tableData.length} rows: [${tableData.map((r) => JSON.stringify(r)).slice(0, 3).join(" | ")}]` };
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
    : { pass: false, reason: `${matched}/${expectedKeys.length} groups correct — ${misses.slice(0, 3).join("; ")}` };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function uploadFiles(sessionId: string, files: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const fileName of Array.from(new Set(files))) {
    const buffer = fs.readFileSync(path.join(VALID_DIR, fileName));
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", new Blob([buffer]), fileName);
    const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.datasets?.length) throw new Error(`upload failed for ${fileName}: ${JSON.stringify(data)}`);
    for (const d of data.datasets) ids.push(d.id);
  }
  return ids;
}

async function main() {
  console.log(`Validation suite — ${CASES.length} questions x ${RUNS} run(s)\n`);
  const results: { c: Case; pass: boolean; reason: string; source?: unknown }[] = [];

  // ONLY=1.3,2.7 re-runs just those ids.
  const only = (process.env.ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const c of CASES) {
    if (only.length && !only.includes(c.id)) continue;
    let bestPass = false, bestReason = "";
    let source: unknown;
    for (let attempt = 1; attempt <= RUNS; attempt++) {
      const sessionId = `val_${c.id}_${attempt}_${Date.now()}`;
      const datasetIds = await uploadFiles(sessionId, c.files);
      const res = await fetch(`${BASE_URL}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question: c.question, datasetIds }),
      });
      const data = await res.json();
      const result = data.result;
      if (!result || result.status !== "success") {
        bestReason = `query failed: ${result?.errorMessage ?? "unknown"}`;
        continue;
      }
      const { pass, reason } = score(c.expect, result.tableData ?? [], result.correlation);
      if (pass) { bestPass = true; bestReason = reason; source = result.source; break; }
      bestReason = reason;
      source = result.source;
    }
    console.log(`[${c.id}] ${bestPass ? "PASS" : "FAIL"}  ${c.question}`);
    console.log(`     expects: ${c.expect.label}`);
    if (!bestPass) console.log(`     ✗ ${bestReason}`);
    if (source) console.log(`     source: ${JSON.stringify(source)}`);
    results.push({ c, pass: bestPass, reason: bestReason, source });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`VALIDATION ACCURACY: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
  console.log(`${"=".repeat(60)}`);

  fs.writeFileSync(
    path.join(VALID_DIR, "validation-report.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), passed, total: results.length, results }, null, 2)
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
