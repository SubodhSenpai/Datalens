/**
 * Runs every Tier 2 question from test-data/validation-v2/TEST_QUESTIONS_V2.md
 * against the live app (dev server on :3000) and writes a full per-question
 * trace to test-data/validation-v2/logs/tier2/<id>.log, plus SUMMARY.md.
 *
 * This is evidence collection, not analysis: each log holds the exact
 * question sent, the datasets in scope, every pipeline step (prompt, raw
 * model reply, validation repairs, joins, execution), the final rows and the
 * explanation — everything needed to say WHY an answer came out the way it
 * did without re-running anything.
 *
 * One session, all four files uploaded once, 13 planner questions.
 * Run: npx tsx scripts/run-tier2-v2.ts
 *   TIERS=1,2      which tiers' questions to send (default 2)
 *   MODE=rag       send mode:"rag" so the RAG path answers instead of the planner
 *   ONLY=2.3,2.4   only these ids
 *   RUN_LABEL=x    log folder name
 */
import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";
// SET=validation-v3 points at another set; its files and question key are discovered in the folder.
const SET = process.env.SET ?? "validation-v2";
const DIR = path.resolve(__dirname, "../test-data", SET);
const DATA_FILES = fs.readdirSync(DIR).filter((f) => /\.(csv|xlsx)$/i.test(f)).sort();
const QUESTIONS_FILE = fs.readdirSync(DIR).find((f) => /^TEST_QUESTIONS.*\.md$/i.test(f)) ?? "TEST_QUESTIONS_V2.md";

// Optional: send one specific key with every query (the app's bring-your-
// own-key path uses it exclusively). USE_ENV_KEY=OPENROUTER_API_KEY3 reads
// that variable from .env; unset → the server's own rotation is used.
function keyFromEnvFile(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const env = fs.readFileSync(path.resolve(__dirname, "..", ".env"), "utf8");
  const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
  return m?.[1]?.trim().replace(/^["']|["']$/g, "");
}
const API_KEY = keyFromEnvFile(process.env.USE_ENV_KEY);
const LOG_DIR = path.join(DIR, "logs", process.env.RUN_LABEL ?? "tier2");
fs.mkdirSync(LOG_DIR, { recursive: true });

// Pulled from TEST_QUESTIONS_V2.md so the expected text in each log is the
// key as generated, not retyped. Test-author hints in parentheses ("needs
// …", "anti-join") are stripped from what is SENT — a user wouldn't type
// them — but kept in the log for reference.
const md = fs.readFileSync(path.join(DIR, QUESTIONS_FILE), "utf8");
const TIERS = (process.env.TIERS ?? "2").split(",").map((t) => t.trim()).filter(Boolean);
const MODE = process.env.MODE === "rag" ? "rag" : "deterministic";
const tierText = TIERS.map((t) => md.split(`## Tier ${t}`)[1]?.split(/\n## Tier /)[0] ?? "").join("\n");
const CASES = tierText
  .split("\n")
  .filter((l) => /^\| \d+\.\d+ \|/.test(l))
  .map((l) => {
    const cells = l.split("|").map((c) => c.trim());
    const id = cells[1];
    const original = cells[2];
    // Tiers 1-2 have one expected cell; Tier 3 has chart + data, Tier 4 has what-it-tests + expected.
    const expected = cells.slice(3, -1).filter(Boolean).join(" | ");
    // Only author hints are stripped ("needs …", "anti-join"); a parenthetical that defines the question ("open subscriptions") is part of it.
    const question = original.replace(/\s*\((?=[^)]*(needs|anti-join|join))[^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    return { id, original, question, expected };
  });

interface Step { id: string; label: string; status: string; summary: string; detail?: string; payload?: unknown; payloadLabel?: string; ms?: number; rowsIn?: number; rowsOut?: number }

function renderTrace(steps: Step[]): string {
  return steps
    .map((s) => {
      const head = `### [${s.status.toUpperCase()}] ${s.id} — ${s.label}${s.ms != null ? ` (${s.ms} ms)` : ""}`;
      const rows = s.rowsIn != null || s.rowsOut != null ? `rows: ${s.rowsIn ?? "?"} → ${s.rowsOut ?? "?"}` : "";
      const payload = s.payload != null ? `${s.payloadLabel ?? "payload"}:\n${JSON.stringify(s.payload, null, 2)}` : "";
      return [head, s.summary, rows, s.detail ?? "", payload].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

async function main() {
  const sessionId = "v2t2_" + Math.random().toString(36).slice(2);
  const ids: string[] = [];
  const uploaded: string[] = [];
  for (const f of DATA_FILES) {
    const form = new FormData();
    form.set("sessionId", sessionId);
    form.append("files", new Blob([fs.readFileSync(path.join(DIR, f))]), f);
    const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
    const d = await r.json();
    if (!d.datasets?.length) { console.error(`upload failed for ${f}:`, d.error, d.errors); process.exit(1); }
    for (const x of d.datasets) { ids.push(x.id); uploaded.push(`${x.name} (${x.rowCount} rows)`); }
  }
  console.log(`session ${sessionId}: ${ids.length} datasets in scope\n  ${uploaded.join("\n  ")}\n  key: ${API_KEY ? `${process.env.USE_ENV_KEY} (…${API_KEY.slice(-6)})` : "server rotation"}\n`);

  const summary: string[] = [
    `# Tier ${TIERS.join("+")} run — ${SET} — mode: ${MODE}`,
    "",
    `Session \`${sessionId}\`, ${ids.length} datasets: ${uploaded.join(", ")}`,
    "",
    "| # | Question sent | Rows | Base → joins | Repairs | Fallback? | Answer (first rows) | Expected |",
    "|---|---|---|---|---|---|---|---|",
  ];

  // ONLY=2.3,2.4 re-runs just those ids (everything else is skipped).
  const only = (process.env.ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const c of CASES) {
    if (only.length && !only.includes(c.id)) continue;
    const started = Date.now();
    let body: Record<string, unknown> = {};
    let error = "";
    try {
      const res = await fetch(`${BASE}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question: c.question, datasetIds: ids, mode: MODE, ...(API_KEY ? { apiKey: API_KEY } : {}) }),
      });
      body = await res.json();
      if (!res.ok) error = `HTTP ${res.status}: ${JSON.stringify(body)}`;
    } catch (e) {
      error = String(e);
    }
    const ms = Date.now() - started;
    const result = (body.result ?? {}) as Record<string, unknown>;
    const trace = (result.trace ?? []) as Step[];
    const rows = (result.tableData ?? []) as Record<string, unknown>[];
    const source = (result.source ?? {}) as Record<string, unknown>;
    const fallback = trace.some((s) => /keyword planner|did not return a plan|Fell back/i.test(s.summary + (s.detail ?? "")));
    const repairs = (result.planRepairs ?? []) as string[];

    const log = [
      `# ${c.id} — ${c.original}`,
      "",
      `Question SENT: ${c.question}`,
      `Expected: ${c.expected}`,
      `Wall time: ${ms} ms${error ? `\nERROR: ${error}` : ""}`,
      "",
      "## Answer",
      `Columns: ${JSON.stringify(result.columns)}`,
      `Rows returned: ${rows.length}`,
      "```json",
      JSON.stringify(rows.slice(0, 25), null, 2),
      "```",
      "",
      "## Explanation shown to the user",
      String(result.explanation ?? ""),
      "",
      "## Source",
      JSON.stringify(source, null, 2),
      "",
      "## Plan repairs",
      repairs.length ? repairs.map((r) => `- ${r}`).join("\n") : "(none)",
      "",
      "## Pandas equivalent",
      "```python",
      String(result.pandasCode ?? ""),
      "```",
      "",
      "## Full pipeline trace",
      renderTrace(trace),
      "",
      "## Raw response (for anything not rendered above)",
      "```json",
      JSON.stringify(body, null, 2),
      "```",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(LOG_DIR, `${c.id.replace(".", "_")}.log.md`), log);

    const firstRows = (rows.length
      ? rows.slice(0, 3).map((r) => Object.values(r).join(" / ")).join(" ; ")
      : String(result.explanation ?? "").split(" Important:")[0]).slice(0, 160).replace(/\|/g, "/");
    const joins = `${source.files ? (source.files as string[]).join(" + ") : "?"}`;
    summary.push(`| ${c.id} | ${c.question.slice(0, 60)} | ${rows.length} | ${joins} | ${repairs.length} | ${fallback ? "YES" : ""} | ${firstRows || (error ? "ERROR" : "—")} | ${c.expected.slice(0, 70).replace(/\|/g, "/")}… |`);
    console.log(`${c.id}  rows=${rows.length}  files=${joins}  repairs=${repairs.length}${fallback ? "  FALLBACK" : ""}${error ? "  ERROR" : ""}  (${ms} ms)`);
    if (MODE === "rag") console.log(`      ${firstRows}`);
  }

  fs.writeFileSync(path.join(LOG_DIR, "SUMMARY.md"), summary.join("\n") + "\n");
  console.log(`\nlogs: ${LOG_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
