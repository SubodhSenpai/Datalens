/**
 * Golden plans for the validation-v3 (sensor) set — no LLM. Each case is the
 * CORRECT selection for a cross-file question; it is compiled, validated and
 * executed, and the result is checked against a ground truth recomputed
 * here from the raw files. A failure is therefore an engine/compiler
 * regression, never model variance. Run: npx tsx scripts/run-golden-v3.ts
 */
import * as fs from "fs";
import * as path from "path";
import { parseCSVBuffer, parseXLSXBuffer } from "../src/lib/parse";
import { detectRelationships } from "../src/lib/relationships";
import { buildSemanticModel } from "../src/lib/semantic-model";
import { compileSelection, Selection } from "../src/lib/compile-selection";
import { validateAndRepairPlan } from "../src/lib/plan-validator";
import { executeQueryPlan, joinRows } from "../src/lib/query-engine";
import { mergeAggregatedResults } from "../src/lib/merge-results";
import type { DatasetRecord } from "../src/lib/session-store";

type Row = Record<string, unknown>;
const DIR = path.resolve(__dirname, "../test-data/validation-v3");
const ds: DatasetRecord[] = [];
for (const f of fs.readdirSync(DIR)) {
  if (f.endsWith(".csv")) { const p = parseCSVBuffer(fs.readFileSync(path.join(DIR, f))); ds.push({ id: f, name: f, columns: p.columns, rows: p.rows, rowCount: p.rowCount, notes: p.notes } as DatasetRecord); }
  else if (f.endsWith(".xlsx")) for (const s of parseXLSXBuffer(fs.readFileSync(path.join(DIR, f)))) ds.push({ id: `${f}:${s.sheetName}`, name: `${f} — ${s.sheetName}`, columns: s.columns, rows: s.rows, rowCount: s.rowCount, notes: s.notes } as DatasetRecord);
}
const rows = (name: string) => ds.find((d) => d.name === name)!.rows!;
const STATIONS = "stations.csv", SENSORS = "sensors.csv", HOURLY = "readings.xlsx — Hourly", THRESH = "readings.xlsx — Thresholds", VISITS = "maintenance.xlsx — Visits";
const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const r2 = (n: number) => Math.round(n * 100) / 100;

// Ground truth, from the raw rows (sentinels are already blank after parsing; Suspect excluded explicitly).
const sensorBy = new Map(rows(SENSORS).map((s) => [String(s.sensor_id), s]));
const stationBy = new Map(rows(STATIONS).map((s) => [String(s.station_id), s]));
const limitOf = new Map(rows(THRESH).map((t) => [String(t.parameter), num(t.guideline_limit)]));
// Duplicate rows (same sensor + timestamp) are one reading, as the engine's grouping treats them.
const seenReading = new Set<string>();
const ok = rows(HOURLY).filter((r) => r.quality_flag === "OK").filter((r) => { const k = `${r.sensor_id}|${r.timestamp}`; if (seenReading.has(k)) return false; seenReading.add(k); return true; });
const paramOf = (r: Row) => String(sensorBy.get(String(r.sensor_id))?.parameter);
const stationOf = (r: Row) => stationBy.get(String(sensorBy.get(String(r.sensor_id))?.station_id))!;
const groupAvg = (pairs: [string, number][]) => { const s = new Map<string, [number, number]>(); for (const [k, v] of pairs) { if (Number.isNaN(v)) continue; const e = s.get(k) ?? [0, 0]; s.set(k, [e[0] + v, e[1] + 1]); } return new Map([...s].map(([k, [t, n]]) => [k, r2(t / n)])); };
const groupCount = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m; };

async function main() {
  const rels = await detectRelationships(ds);
  const model = buildSemanticModel(ds, rels);
  const alias = (name: string) => model.tables.find((t) => t.name === name)!.alias;
  const H = alias(HOURLY), T = alias(THRESH), S = alias(SENSORS), ST = alias(STATIONS), V = alias(VISITS);

  const execute = (sel: Selection, q: string) => {
    const c = compileSelection(sel, model);
    const parts = c.plans.map((plan) => {
      const v = validateAndRepairPlan(plan, q, ds.map((d) => ({ id: d.id, name: d.name, columns: d.columns })), rels);
      const base = ds.find((d) => d.id === v.plan.datasetId)!;
      let working = base.rows!;
      for (const j of v.plan.joins ?? []) { const jd = ds.find((d) => d.id === j.datasetId)!; working = joinRows(working, jd.rows!, jd.name, j.leftOn ?? j.on!, j.rightOn ?? j.on!, j.type ?? "inner"); }
      return { ...executeQueryPlan(working, v.plan), repairs: v.repairs.map((r) => r.detail) };
    });
    const merged = parts.length > 1 ? mergeAggregatedResults(parts.map((p) => ({ columns: p.columns, rows: p.rows })), c.mergeDimensionCount) : parts[0];
    return { rows: merged.rows as Row[], correlation: parts[0].correlation, repairs: parts.flatMap((p) => p.repairs) };
  };
  const mapEq = (got: Row[], key: string, val: string, exp: Map<string, number>, tol = 0.02) => {
    const g = new Map(got.map((r) => [String(r[key]), num(r[val])]));
    const off = [...exp].filter(([k, v]) => !g.has(k) || Math.abs((g.get(k) ?? NaN) - v) > Math.max(tol, Math.abs(v) * 0.005));
    return { ok: off.length === 0, detail: `${exp.size - off.length}/${exp.size} groups${off.length ? " off: " + off.map(([k, v]) => `${k} got ${g.get(k)} exp ${v}`).join("; ") : ""}` };
  };

  const pm = ok.filter((r) => paramOf(r) === "PM2.5");
  const cases: { id: string; q: string; sel: Selection; verify: (got: Row[], corr?: { coefficient: number; sampleSize: number }) => { ok: boolean; detail: string } }[] = [
    { id: "2.1", q: "Average PM2.5 by region", sel: { dimensions: [`${ST}.region`], measures: [{ ref: `${H}.value`, fn: "avg", as: "avg_pm25" }], filters: [{ ref: `${S}.parameter`, op: "eq", value: "PM2.5" }, { ref: `${H}.quality_flag`, op: "eq", value: "OK" }] },
      verify: (got) => mapEq(got, "region", "avg_pm25", groupAvg(pm.map((r) => [String(stationOf(r).region), num(r.value)]))) },
    { id: "2.3", q: "How many PM2.5 readings exceeded the guideline, by region?", sel: { dimensions: [`${ST}.region`], measures: [{ ref: `${H}.reading_id`, fn: "count", as: "exceeded" }], filters: [{ ref: `${S}.parameter`, op: "eq", value: "PM2.5" }, { ref: `${H}.quality_flag`, op: "eq", value: "OK" }, { ref: `${H}.value`, op: "gt", valueRef: `${T}.guideline_limit` }] },
      verify: (got) => mapEq(got, "region", "exceeded", groupCount(pm.filter((r) => num(r.value) > limitOf.get("PM2.5")!).map((r) => String(stationOf(r).region))), 3) },
    { id: "2.4", q: "What share of PM2.5 readings exceed the guideline in each region?", sel: { dimensions: [`${ST}.region`], measures: [{ ref: `${H}.reading_id`, fn: "count", as: "total" }, { ref: `${H}.reading_id`, fn: "count", as: "exceeding", where: [{ ref: `${H}.value`, op: "gt", valueRef: `${T}.guideline_limit` }] }], filters: [{ ref: `${S}.parameter`, op: "eq", value: "PM2.5" }, { ref: `${H}.quality_flag`, op: "eq", value: "OK" }], derive: [{ as: "share_pct", expr: "exceeding / total * 100" }] },
      verify: (got) => { const tot = groupCount(pm.map((r) => String(stationOf(r).region))); const exc = groupCount(pm.filter((r) => num(r.value) > limitOf.get("PM2.5")!).map((r) => String(stationOf(r).region))); return mapEq(got, "region", "share_pct", new Map([...tot].map(([k, n]) => [k, r2(100 * (exc.get(k) ?? 0) / n)])), 0.3); } },
    { id: "2.6", q: "When and where was the highest PM2.5 reading?", sel: { select: [`${H}.timestamp`, `${ST}.station_name`, `${H}.value`], filters: [{ ref: `${S}.parameter`, op: "eq", value: "PM2.5" }, { ref: `${H}.quality_flag`, op: "eq", value: "OK" }], sort: [{ column: `${H}.value`, direction: "desc" }], limit: 1 },
      verify: (got) => { const top = [...pm].sort((a, b) => num(b.value) - num(a.value))[0]; const g = got[0]; return { ok: !!g && num(g.value) === num(top.value) && String(g.station_name) === String(stationOf(top).station_name), detail: `got ${g?.value} at ${g?.station_name}, expected ${top.value} at ${stationOf(top).station_name}` }; } },
    { id: "2.9", q: "Maintenance visits and total cost by region", sel: { dimensions: [`${ST}.region`], measures: [{ ref: `${V}.visit_id`, fn: "count", as: "visits" }, { ref: `${V}.cost_usd`, fn: "sum", as: "cost" }] },
      verify: (got) => mapEq(got, "region", "visits", groupCount(rows(VISITS).map((v) => String(stationBy.get(String(v.site_code))!.region)))) },
    { id: "2.12", q: "Which stations had no maintenance visit at all?", sel: { select: [`${ST}.station_id`, `${ST}.station_name`], without: [V] },
      verify: (got) => { const visited = new Set(rows(VISITS).map((v) => String(v.site_code))); const exp = rows(STATIONS).filter((s) => !visited.has(String(s.station_id))).length; return { ok: got.length === exp, detail: `${got.length} rows, expected ${exp}` }; } },
    { id: "2.13", q: "Which stations have no readings in the Hourly sheet?", sel: { select: [`${ST}.station_id`, `${ST}.station_name`], without: [H] },
      verify: (got) => { const reporting = new Set(rows(HOURLY).map((r) => String(sensorBy.get(String(r.sensor_id))?.station_id))); const exp = rows(STATIONS).filter((s) => !reporting.has(String(s.station_id))).length; return { ok: got.length === exp, detail: `${got.length} rows, expected ${exp}` }; } },
    { id: "2.15", q: "Is there a correlation between temperature and ozone?", sel: { dimensions: [`${S}.station_id`, `${H}.timestamp`], measures: [{ ref: `${H}.value`, fn: "avg", as: "temp", where: [{ ref: `${S}.parameter`, op: "eq", value: "temperature" }, { ref: `${S}.unit`, op: "eq", value: "°C" }] }, { ref: `${H}.value`, fn: "avg", as: "o3", where: [{ ref: `${S}.parameter`, op: "eq", value: "O3" }] }], filters: [{ ref: `${H}.quality_flag`, op: "eq", value: "OK" }], correlate: { x: "temp", y: "o3" } },
      verify: (_got, corr) => { const o3At = new Map(ok.filter((r) => paramOf(r) === "O3").map((r) => [`${sensorBy.get(String(r.sensor_id))!.station_id}|${r.timestamp}`, num(r.value)])); const pairs = ok.filter((r) => paramOf(r) === "temperature" && sensorBy.get(String(r.sensor_id))!.unit === "°C").map((r) => [num(r.value), o3At.get(`${sensorBy.get(String(r.sensor_id))!.station_id}|${r.timestamp}`)] as [number, number | undefined]).filter((p): p is [number, number] => p[1] !== undefined); const n = pairs.length, mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } const exp = r2(sxy / Math.sqrt(sxx * syy)); return { ok: !!corr && Math.abs(corr.coefficient - exp) < 0.01 && corr.sampleSize === n, detail: `r=${corr?.coefficient} n=${corr?.sampleSize}, expected r=${exp} n=${n}` }; } },
  ];

  let bad = 0;
  for (const c of cases) {
    const { rows: got, correlation, repairs } = execute(c.sel, c.q);
    const v = c.verify(got, correlation);
    if (!v.ok) bad++;
    console.log(`${v.ok ? "PASS" : "FAIL"}  ${c.id} ${c.q}\n      ${v.detail}${repairs.length ? `\n      repairs: ${repairs.join(" | ")}` : ""}`);
  }
  console.log(bad ? `\n${bad} FAILED` : "\nALL PASS");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
