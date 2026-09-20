/**
 * Offline proof of the selection compiler on validation-v2 Tier 2. No LLM.
 *
 * For each question, the CORRECT selection (what a planner should output:
 * measures, dimensions, filters — never a join) is compiled to a QueryPlan,
 * passed through the real validator, executed by the real engine, and the
 * result is compared with an expectation computed independently here from
 * the parsed rows. If the compiler chose the wrong base, the wrong join, or
 * the wrong post-join column name, the numbers won't match.
 *
 * Expectations mirror join semantics on the files AS THEY ARE (the
 * duplicated customer row is joined twice, the Payments TOTAL row is a
 * row): this proves the compiler, not the data-quality traps, which are
 * tested elsewhere.
 *
 * Run: npx tsx scripts/run-selection-compiler.ts
 */
import fs from "fs";
import path from "path";
import { parseCSVBuffer, parseXLSXBuffer } from "../src/lib/parse";
import { detectRelationships } from "../src/lib/relationships";
import { buildSemanticModel } from "../src/lib/semantic-model";
import { compileSelection, Selection } from "../src/lib/compile-selection";
import { validateAndRepairPlan } from "../src/lib/plan-validator";
import { joinRows, executeQueryPlan } from "../src/lib/query-engine";
import { mergeAggregatedResults } from "../src/lib/merge-results";
import type { DatasetRecord } from "../src/lib/session-store";
import type { QueryPlan } from "../src/lib/types";

const DIR = path.resolve(__dirname, "../../test-data/validation-v2");
const ds: DatasetRecord[] = [];
for (const f of ["customers.csv", "subscriptions.csv"]) {
  const p = parseCSVBuffer(fs.readFileSync(path.join(DIR, f)));
  ds.push({ id: f, name: f, columns: p.columns, rows: p.rows, rowCount: p.rowCount } as DatasetRecord);
}
for (const f of ["billing.xlsx", "support.xlsx"]) {
  for (const s of parseXLSXBuffer(fs.readFileSync(path.join(DIR, f)))) {
    const n = `${f} — ${s.sheetName}`;
    ds.push({ id: n, name: n, columns: s.columns, rows: s.rows, rowCount: s.rowCount } as DatasetRecord);
  }
}
const rows = (id: string) => ds.find((d) => d.id === id)!.rows!;
const CUST = "customers.csv", SUBS = "subscriptions.csv", INV = "billing.xlsx — Invoices", PAY = "billing.xlsx — Payments", TIX = "support.xlsx — Tickets", AG = "support.xlsx — Agents";
type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;

// Independent lookups — a LIST per key, so a duplicated key contributes twice, as a join would.
const listBy = (rs: Row[], key: string) => { const m = new Map<string, Row[]>(); for (const r of rs) { const k = String(r[key]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const custBy = listBy(rows(CUST), "customer_id");
const agentBy = listBy(rows(AG), "agent_id");
const groupSum = (pairs: [string, number][]) => { const m = new Map<string, number>(); for (const [k, v] of pairs) m.set(k, r2((m.get(k) ?? 0) + v)); return m; };
const groupCount = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m; };
const groupAvg = (pairs: [string, number][]) => { const s = new Map<string, [number, number]>(); for (const [k, v] of pairs) { if (Number.isNaN(v)) continue; const e = s.get(k) ?? [0, 0]; s.set(k, [e[0] + v, e[1] + 1]); } return new Map([...s].map(([k, [t, n]]) => [k, r2(t / n)])); };

function runOne(plan: QueryPlan, question: string) {
  const v = validateAndRepairPlan(plan, question, ds.map((d) => ({ id: d.id, name: d.name, columns: d.columns })), rels);
  let working = rows(v.plan.datasetId);
  for (const j of v.plan.joins ?? []) {
    const other = ds.find((d) => d.id === j.datasetId)!;
    working = joinRows(working, other.rows!, other.name, j.leftOn ?? j.on!, j.rightOn ?? j.on!, j.type ?? "inner");
  }
  return { plan: v.plan, repairs: v.repairs, result: executeQueryPlan(working, v.plan) };
}
function run(compiled: { plans: QueryPlan[]; mergeDimensionCount: number }, question: string) {
  const parts = compiled.plans.map((p) => runOne(p, question));
  const merged = mergeAggregatedResults(parts.map((p) => ({ columns: p.result.columns, rows: p.result.rows })), compiled.mergeDimensionCount);
  return { plan: parts[0].plan, plans: parts.map((p) => p.plan), repairs: parts.flatMap((p) => p.repairs), result: { ...parts[0].result, columns: merged.columns, rows: merged.rows } };
}

let rels: Awaited<ReturnType<typeof detectRelationships>>;
let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`); };
const mapEq = (got: Row[], keyCol: string, valCol: string, exp: Map<string, number>, tol = 0.005) => {
  const g = new Map(got.map((r) => [String(r[keyCol]), num(r[valCol])]));
  const missing = [...exp.keys()].filter((k) => !g.has(k));
  // Relative tolerance with a tiny absolute floor: ±1.0 would hide a whole
  // point of error on a 1–5 rating scale.
  const off = [...exp].filter(([k, v]) => g.has(k) && Math.abs(g.get(k)! - v) > Math.max(0.01, Math.abs(v) * tol)).map(([k, v]) => `${k}: got ${g.get(k)} expected ${v}`);
  return { ok: missing.length === 0 && off.length === 0 && g.size === exp.size, detail: `${g.size}/${exp.size} groups${missing.length ? ` missing ${missing.join(",")}` : ""}${off.length ? ` off: ${off.slice(0, 3).join("; ")}` : ""}` };
};

async function main() {
  rels = await detectRelationships(ds);
  const model = buildSemanticModel(ds, rels);
  console.log(`semantic model: ${model.tables.length} tables, ${model.measures.length} measures, ${model.dimensions.length} dimensions\n`);

  const A = { CUST: "customers", SUBS: "subscriptions", INV: "billing_xlsx_Invoices", PAY: "billing_xlsx_Payments", TIX: "support_xlsx_Tickets", AG: "support_xlsx_Agents" };
  const cases: { id: string; q: string; sel: Selection; verify: (got: Row[], plan: QueryPlan) => { ok: boolean; detail: string } }[] = [
    { id: "2.1", q: "Total invoiced amount by industry",
      sel: { measures: [{ ref: `${A.INV}.amount`, fn: "sum", as: "invoiced" }], dimensions: [`${A.CUST}.industry`] },
      verify: (got) => mapEq(got, "industry", "invoiced", groupSum(rows(INV).flatMap((i) => (custBy.get(String(i.customer_id)) ?? []).map((c) => [String(c.industry), num(i.amount)] as [string, number])))) },
    { id: "2.2", q: "Top 5 countries by invoiced amount",
      sel: { measures: [{ ref: `${A.INV}.amount`, fn: "sum", as: "invoiced" }], dimensions: [`${A.CUST}.country`], sort: [{ column: "invoiced", direction: "desc" }], limit: 5 },
      verify: (got) => { const exp = [...groupSum(rows(INV).flatMap((i) => (custBy.get(String(i.customer_id)) ?? []).map((c) => [String(c.country), num(i.amount)] as [string, number])))].sort((a, b) => b[1] - a[1]).slice(0, 5); return mapEq(got, "country", "invoiced", new Map(exp)); } },
    { id: "2.3", q: "Which account manager manages the most customers?",
      sel: { measures: [{ ref: `${A.CUST}.customer_id`, fn: "countDistinct", as: "customers" }], dimensions: [`${A.AG}.agent_name`], sort: [{ column: "customers", direction: "desc" }], limit: 3 },
      verify: (got) => { const m = new Map<string, Set<string>>(); for (const c of rows(CUST)) for (const a of agentBy.get(String(c.account_manager_id)) ?? []) (m.get(String(a.agent_name)) ?? m.set(String(a.agent_name), new Set()).get(String(a.agent_name))!).add(String(c.customer_id)); const exp = [...m].map(([k, s]) => [k, s.size] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 3); return mapEq(got, "agent_name", "customers", new Map(exp)); } },
    { id: "2.4a", q: "Total invoiced amount",
      sel: { measures: [{ ref: `${A.INV}.amount`, fn: "sum", as: "invoiced" }] },
      verify: (got) => { const exp = r2(rows(INV).reduce((s, r) => s + num(r.amount), 0)); const g = num(got[0]?.invoiced); return { ok: Math.abs(g - exp) < 1, detail: `got ${g} expected ${exp}` }; } },
    { id: "2.4b", q: "Total paid amount",
      sel: { measures: [{ ref: `${A.PAY}.amount`, fn: "sum", as: "paid" }] },
      verify: (got) => { const exp = r2(rows(PAY).reduce((s, r) => s + num(r.amount), 0)); const g = num(got[0]?.paid); return { ok: Math.abs(g - exp) < 1, detail: `got ${g} expected ${exp} (includes the TOTAL row — the data-quality trap, tested elsewhere)` }; } },
    { id: "2.4c", q: "Total invoiced vs total paid (multi-fact, one row)",
      sel: { measures: [{ ref: `${A.INV}.amount`, fn: "sum", as: "invoiced" }, { ref: `${A.PAY}.amount`, fn: "sum", as: "paid" }] },
      verify: (got) => { const ei = r2(rows(INV).reduce((s, r) => s + num(r.amount), 0)); const ep = r2(rows(PAY).reduce((s, r) => s + num(r.amount), 0)); const gi = num(got[0]?.invoiced), gp = num(got[0]?.paid); return { ok: got.length === 1 && Math.abs(gi - ei) < 1 && Math.abs(gp - ep) < 1, detail: `invoiced ${gi} (exp ${ei}), paid ${gp} (exp ${ep}) in ${got.length} row` }; } },
    { id: "2.4d", q: "Invoiced vs paid by country (multi-fact, merged on a dimension)",
      sel: { measures: [{ ref: `${A.INV}.amount`, fn: "sum", as: "invoiced" }, { ref: `${A.PAY}.amount`, fn: "sum", as: "paid" }], dimensions: [`${A.CUST}.country`] },
      verify: (got) => {
        const invByC = groupSum(rows(INV).flatMap((i) => (custBy.get(String(i.customer_id)) ?? []).map((c) => [String(c.country), num(i.amount)] as [string, number])));
        const invById = listBy(rows(INV), "invoice_id");
        const payByC = groupSum(rows(PAY).flatMap((p) => (invById.get(String(p.invoice_id)) ?? []).flatMap((i) => (custBy.get(String(i.customer_id)) ?? []).map((c) => [String(c.country), num(p.amount)] as [string, number]))));
        const a = mapEq(got, "country", "invoiced", invByC), b = mapEq(got.filter((r) => r.paid != null), "country", "paid", payByC);
        return { ok: a.ok && b.ok, detail: `invoiced: ${a.detail} | paid: ${b.detail}` };
      } },
    { id: "2.5", q: "Which customers have unpaid or overdue invoices over $5,000?",
      sel: { select: [`${A.INV}.invoice_id`, `${A.INV}.customer_id`, `${A.INV}.amount`, `${A.INV}.status`], filters: [{ ref: `${A.INV}.status`, op: "neq", value: "Paid" }, { ref: `${A.INV}.amount`, op: "gt", value: 5000 }] },
      verify: (got) => { const exp = rows(INV).filter((r) => r.status !== "Paid" && num(r.amount) > 5000).length; return { ok: got.length === exp, detail: `${got.length} rows, expected ${exp}` }; } },
    { id: "2.6", q: "Tickets by customer industry",
      sel: { measures: [{ ref: `${A.TIX}.ticket_id`, fn: "count", as: "tickets" }], dimensions: [`${A.CUST}.industry`] },
      verify: (got) => mapEq(got, "industry", "tickets", groupCount(rows(TIX).flatMap((t) => (custBy.get(String(t.customer_id)) ?? []).map((c) => String(c.industry))))) },
    { id: "2.7", q: "Average CSAT by support team",
      sel: { measures: [{ ref: `${A.TIX}.csat`, fn: "avg", as: "avg_csat" }], dimensions: [`${A.AG}.team`] },
      verify: (got) => mapEq(got, "team", "avg_csat", groupAvg(rows(TIX).flatMap((t) => (agentBy.get(String(t.agent_id)) ?? []).map((a) => [String(a.team), num(t.csat)] as [string, number]))), 0.01) },
    { id: "2.8", q: "MRR by country",
      sel: { derive: [{ as: "mrr", expr: `${A.SUBS}.seats * ${A.SUBS}.price_per_seat` }], measures: [{ ref: "mrr", fn: "sum", as: "mrr_total" }], dimensions: [`${A.CUST}.country`], filters: [{ ref: `${A.SUBS}.end_date`, op: "isNull" }] },
      verify: (got) => mapEq(got, "country", "mrr_total", groupSum(rows(SUBS).filter((s) => s.end_date === null || s.end_date === "").flatMap((s) => (custBy.get(String(s.customer_id)) ?? []).map((c) => [String(c.country), num(s.seats) * num(s.price_per_seat)] as [string, number])))) },
    { id: "2.9", q: "Which customers have never raised a ticket?",
      sel: { select: [`${A.CUST}.customer_id`, `${A.CUST}.company`], without: [A.TIX] },
      verify: (got) => { const withT = new Set(rows(TIX).map((t) => String(t.customer_id))); const exp = rows(CUST).filter((c) => !withT.has(String(c.customer_id))).length; return { ok: got.length === exp, detail: `${got.length} rows, expected ${exp}` }; } },
    { id: "2.10", q: "Which agent has no tickets assigned?",
      sel: { select: [`${A.AG}.agent_id`, `${A.AG}.agent_name`, `${A.AG}.team`], without: [A.TIX] },
      verify: (got) => { const withT = new Set(rows(TIX).map((t) => String(t.agent_id))); const exp = rows(AG).filter((a) => !withT.has(String(a.agent_id))); return { ok: got.length === exp.length && got.every((g) => exp.some((e) => e.agent_id === g.agent_id)), detail: `${got.map((g) => g.agent_id).join(",")} expected ${exp.map((e) => e.agent_id).join(",")}` }; } },
    { id: "2.11", q: "Which industry has the slowest average resolution?",
      sel: { measures: [{ ref: `${A.TIX}.resolution_hours`, fn: "avg", as: "avg_hours" }], dimensions: [`${A.CUST}.industry`], sort: [{ column: "avg_hours", direction: "desc" }], limit: 1 },
      verify: (got) => { const exp = [...groupAvg(rows(TIX).flatMap((t) => (custBy.get(String(t.customer_id)) ?? []).map((c) => [String(c.industry), num(t.resolution_hours)] as [string, number])))].sort((a, b) => b[1] - a[1])[0]; return { ok: String(got[0]?.industry) === exp[0] && Math.abs(num(got[0]?.avg_hours) - exp[1]) < 0.05, detail: `got ${got[0]?.industry} ${got[0]?.avg_hours}, expected ${exp[0]} ${exp[1]}` }; } },
    { id: "2.12", q: "Are there churned customers with a subscription that is still open?",
      sel: { select: [`${A.CUST}.customer_id`, `${A.SUBS}.subscription_id`, `${A.SUBS}.plan`], filters: [{ ref: `${A.CUST}.status`, op: "eq", value: "Churned" }, { ref: `${A.SUBS}.end_date`, op: "isNull" }] },
      verify: (got) => { const exp = rows(SUBS).filter((s) => (s.end_date === null || s.end_date === "") && (custBy.get(String(s.customer_id)) ?? []).some((c) => c.status === "Churned")).flatMap((s) => (custBy.get(String(s.customer_id)) ?? []).filter((c) => c.status === "Churned")).length; return { ok: got.length === exp, detail: `${got.length} rows, expected ${exp}` }; } },
    { id: "2.13", q: "For each plan, how many customers are Active vs Churned?",
      sel: { measures: [{ ref: `${A.CUST}.customer_id`, fn: "countDistinct", as: "customers" }], dimensions: [`${A.SUBS}.plan`, `${A.CUST}.status`] },
      verify: (got) => { const m = new Map<string, Set<string>>(); for (const s of rows(SUBS)) for (const c of custBy.get(String(s.customer_id)) ?? []) { const k = `${s.plan}|${c.status}`; (m.get(k) ?? m.set(k, new Set()).get(k)!).add(String(c.customer_id)); } const exp = new Map([...m].map(([k, v]) => [k, v.size])); const g = new Map(got.map((r) => [`${r.plan}|${r.status}`, num(r.customers)])); const off = [...exp].filter(([k, v]) => g.get(k) !== v); return { ok: off.length === 0 && g.size === exp.size, detail: `${g.size}/${exp.size} groups${off.length ? " off: " + off.map(([k, v]) => `${k} got ${g.get(k)} exp ${v}`).join("; ") : ""}` }; } },
  ];

  for (const c of cases) {
    const compiled = compileSelection(c.sel, model);
    const { plan, plans, repairs, result } = run(compiled, c.q);
    const v = c.verify(result.rows, plan);
    const joins = plans.map((pl, i) => `${plans.length > 1 ? `[${i + 1}] ` : ""}${pl.datasetId.replace(/^.*— /, "")}${(pl.joins ?? []).map((j) => ` → ${j.type === "left" ? "LEFT " : ""}${j.datasetId.replace(/^.*— /, "")}(${j.leftOn}=${j.rightOn})`).join("")}`).join(" ‖ ");
    const material = repairs.filter((r) => /Dropped|re-based/i.test(r.detail));
    check(`${c.id} ${c.q}`, v.ok && material.length === 0, `${v.detail} | ${joins}${material.length ? " | VALIDATOR: " + material.map((r) => r.detail).join("; ") : ""}${result.warnings.length ? " | warn: " + result.warnings.join("; ") : ""}`);
  }
  console.log(`\n${bad === 0 ? "ALL PASS" : `${bad} FAILED`}`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
