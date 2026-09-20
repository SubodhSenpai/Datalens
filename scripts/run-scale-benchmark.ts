/**
 * Scale check for a 25-file session — the upload-time work (profiling,
 * relationship detection, semantic model) and the per-question work
 * (linking, prompt size after pruning, compile), with no LLM.
 *
 * Synthetic snowflake: 5 fact tables of 2–3k rows, 20 dimension tables of
 * 20–500 rows, generic names (t01…t25, k01…), so nothing here resembles any
 * test set. Run: npx tsx scripts/run-scale-benchmark.ts
 */
import { detectRelationships } from "../src/lib/relationships";
import { buildSemanticModel, renderSemanticMenu } from "../src/lib/semantic-model";
import { linkSchema } from "../src/lib/schema-linking";
import { compileSelection } from "../src/lib/compile-selection";
import { buildPlannerUserMessage } from "../src/lib/llm";
import { parseCSVBuffer } from "../src/lib/parse";
import type { DatasetRecord } from "../src/lib/session-store";

function mulberry32(seed: number) { let a = seed; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(7);
const int = (a: number, b: number) => Math.floor(a + rand() * (b - a + 1));
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];

function csv(rows: Record<string, unknown>[]): Buffer {
  const h = Object.keys(rows[0]);
  return Buffer.from([h.join(","), ...rows.map((r) => h.map((c) => String(r[c] ?? "")).join(","))].join("\n"));
}

// 20 dimension tables: dim01..dim20, each with a unique key, a name, a category, a numeric attribute
const dims: { name: string; key: string; rows: Record<string, unknown>[] }[] = [];
for (let i = 1; i <= 20; i++) {
  const key = `dim${String(i).padStart(2, "0")}_id`;
  const n = int(20, 500);
  const rows = Array.from({ length: n }, (_, k) => ({ [key]: `D${i}-${k + 1}`, [`dim${i}_name`]: `${pick(WORDS)} ${k + 1}`, [`dim${i}_group`]: pick(WORDS.slice(0, 4)), [`dim${i}_weight`]: int(1, 100) }));
  dims.push({ name: `dim${String(i).padStart(2, "0")}.csv`, key, rows });
}
// 5 fact tables: each references 4 dimensions and carries 2 measures + a date
const facts: { name: string; rows: Record<string, unknown>[] }[] = [];
for (let f = 1; f <= 5; f++) {
  const refs = [dims[(f * 4 - 4) % 20], dims[(f * 4 - 3) % 20], dims[(f * 4 - 2) % 20], dims[(f * 4 - 1) % 20]];
  const n = int(2000, 3000);
  const rows = Array.from({ length: n }, (_, k) => {
    const r: Record<string, unknown> = { [`fact${f}_id`]: `F${f}-${k + 1}`, event_date: `2025-0${int(1, 6)}-${String(int(1, 28)).padStart(2, "0")}` };
    for (const d of refs) r[d.key] = pick(d.rows)[d.key];
    r[`fact${f}_qty`] = int(1, 50); r[`fact${f}_amount`] = Number((rand() * 1000).toFixed(2));
    return r;
  });
  facts.push({ name: `fact${f}.csv`, rows });
}

async function main() {
  const t0 = Date.now();
  const ds: DatasetRecord[] = [...facts, ...dims].map((t) => {
    const p = parseCSVBuffer(csv(t.rows));
    return { id: t.name, name: t.name, columns: p.columns, rows: p.rows, rowCount: p.rowCount } as DatasetRecord;
  });
  const tParse = Date.now() - t0;
  const totalRows = ds.reduce((s, d) => s + d.rowCount, 0);

  const t1 = Date.now();
  const rels = await detectRelationships(ds);
  const tRel = Date.now() - t1;
  const trueLinks = 5 * 4;
  const found = rels.filter((r) => r.basis === "name" && /dim\d+_id/.test(r.columnA)).length;

  const t2 = Date.now();
  const model = buildSemanticModel(ds, rels);
  const tModel = Date.now() - t2;

  const q = `Total fact3 amount by dim10 group`;
  const t3 = Date.now();
  const link = linkSchema(q, ds, rels);
  const tLink = Date.now() - t3;

  // Selection-mode prompt size with pruning vs without
  const focus = new Set<string>();
  for (const id of link.requiredDatasetIds) focus.add(id);
  for (const j of link.joinPath) focus.add(j.datasetId);
  for (const c of link.columns) if (c.strength === "strong") for (const id of c.datasetIds) focus.add(id);
  for (const id of [...focus]) for (const r of rels) { if (r.datasetIdA === id) focus.add(r.datasetIdB); if (r.datasetIdB === id) focus.add(r.datasetIdA); }
  const fullMenu = renderSemanticMenu(model);
  const prunedMenu = renderSemanticMenu(model, focus);
  const legacy = buildPlannerUserMessage(q, ds, rels, [], link);

  const t4 = Date.now();
  const compiled = compileSelection({ measures: [{ ref: "fact3.fact3_amount", fn: "sum", as: "total" }], dimensions: ["dim10.dim10_group"] }, model);
  const tCompile = Date.now() - t4;

  console.log(`25 files, ${totalRows.toLocaleString()} rows, ${ds.reduce((s, d) => s + d.columns.length, 0)} columns`);
  console.log(`parse+profile: ${tParse} ms | relationships: ${tRel} ms (${rels.length} found; ${found}/${trueLinks} true key links present; ${rels.length - found} other) | semantic model: ${tModel} ms`);
  console.log(`per question — link: ${tLink} ms | compile: ${tCompile} ms | joins compiled: ${(compiled.plan.joins ?? []).map((j) => j.datasetId).join(", ") || "none"}`);
  console.log(`prompt size — selection menu full: ${fullMenu.length.toLocaleString()} chars, pruned: ${prunedMenu.length.toLocaleString()} chars (${focus.size} of 25 tables in full) | legacy prompt: ${legacy.length.toLocaleString()} chars`);
  const falseLinks = rels.length - found;
  const ok = tRel < 15000 && found === trueLinks && falseLinks <= trueLinks && focus.size < ds.length / 2 && (compiled.plan.joins ?? []).length === 1;
  console.log(ok
    ? "\nPASS — 25 files: detection well under budget, every true key found, false links do not outnumber true ones, under half the tables shown in full, correct single join"
    : `\nFAIL — rel ${tRel} ms, true ${found}/${trueLinks}, false ${falseLinks}, focus ${focus.size}/${ds.length}, joins ${(compiled.plan.joins ?? []).length}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
