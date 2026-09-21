# DataLens — ask your spreadsheets questions

Upload a handful of CSV / Excel files, ask a question in plain English, get back a table, a chart when it makes sense, and a short explanation of how the number was produced.

The important design choice: **the language model never does arithmetic.** It decides *what* to compute (which files, which columns, which filters and joins); a deterministic engine computes it, and every step is shown in a trace so you can check the answer instead of trusting it.

---

## Running it locally

Requirements: Node 20+, an API key for at least one model provider (both have free tiers).

```bash
cd fde-app
npm install
cp .env.example .env      # then fill in a key, see below
npm run dev               # http://localhost:3000
```

`.env` — one of these is enough:

| Variable | What it is |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key (`sk-or-…`). Only free open-source models are used (Qwen 3.8, Gemma 4, GLM 5.2, Nemotron …). Add `OPENROUTER_API_KEY2`, `…3` to rotate keys — the free daily quota is per account. |
| `GEMINI_API_KEY` | Google AI Studio key (`AIza…` / `AQ.…`). Tried before OpenRouter when both are set; `LLM_PROVIDER=openrouter` flips that. |
| `OPENROUTER_MODEL`, `GEMINI_MODEL` | optional — put one model at the front of that provider's fallback chain |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob for uploads — required on Vercel, optional locally (files stay in memory). |
| `NEXT_PUBLIC_BLOB_CLIENT_UPLOADS` | set to `1` on Vercel so files go from the browser straight to Blob; a serverless function only accepts ~4.5 MB per request, which a 7 MB workbook exceeds. Build-time value — redeploy after setting it. |

Visitors can also paste their own key in the UI (top of the sidebar). The provider is recognised from the key's shape and the key never leaves the browser except with the request it authorises.

No key at all → the app refuses to answer rather than guessing. That is deliberate.

---

## Using it

1. Drop up to 25 files (`.csv`, `.xlsx`, `.xls`, 25 MB each). Every sheet of a workbook that holds a table becomes its own dataset.
2. Each file card shows what was found: rows, the identifying column, date range, category values, which other files it links to, and anything the loader had to do (a `TOTAL` row excluded, `-999` treated as missing, `₹1,20,000` read as a number, "active"/"Active" unified …).
3. Ask. Examples that work across files without naming the join:
   - *Total invoiced amount by customer industry*
   - *Which stations have no readings?*
   - *Share of PM2.5 readings above the WHO guideline, by region*
   - *Is there a correlation between annual pay and average rating?*
4. Open the trace under the answer to see the prompt, the model's plan, every correction the validator made, the joins, the executed plan and the equivalent pandas code.

---

## How an answer is produced

```
upload → parse & clean → profile columns → infer PK/FK relationships → semantic model
question → schema link → planner LLM (picks fields from a menu)
        → compiler (joins, post-join names, sub-plans) → validator/repair
        → answer-check (10 structural rules; re-ask the model with feedback, max 3)
        → execute → merge (multi-fact) → chart → explanation LLM
```

Things worth knowing about, because they are where most real-world data goes wrong:

- **Loading.** Placeholders (`N/A`, `-`, `#N/A`) are blanks. Numbers are read through formatting (`$1,200`, `12%`, `(500)`, `9.5 lakh`). Dates in ISO / `dd/mm/yyyy` / `01-Aug-2021` forms are taken as calendar dates, with the day/month order decided per column from the values that disambiguate it. Missing-value codes like `-999` are detected (repeated all-nines value far outside the rest) and blanked. Summary rows are excluded when their numbers equal the column sums, or when the label sits in the id column. All of it is reported on the file card and in the answer.
- **Joins.** Keys are inferred from uniqueness + inclusion (a column is a key only if unique on one side or high-cardinality on both), so a `status` column shared by five files does not link them. A lookup table with a duplicated record is deduplicated at join time, with a note, instead of doubling every figure joined through it. Measures from two fact tables are aggregated separately and merged on the shared dimensions — never joined row-by-row.
- **The plan language.** Filters can compare two columns (`reading > guideline_limit`), a measure can carry its own condition (count-if, sum-if, "value where parameter is X"), derives can run after aggregation (a share), `having` can compare two measures (actual ≥ target), anti-joins work across more than one hop.
- **Guard rails.** The answer-check catches the shapes small models get wrong: a total asked but rows returned, a formula stated but not derived, a named value that was never filtered, "in both periods" without a `having`, a correlation with nothing to correlate, "highest" sorted ascending. Cross-file questions get a second independent draft; the two are compared on what they compute and reconciled if they differ.
- **Honesty.** Blank cells skipped by an aggregate are counted and stated. A data-quality flag column that was not filtered is called out. Mutation requests ("delete …") get a read-only notice. A question the data cannot answer gets told so.

---

## Tech stack

- Next.js 16 (App Router, TypeScript), React 19, Tailwind 4, Recharts, lucide icons
- `papaparse` for CSV, `xlsx` for workbooks, `openai` SDK pointed at OpenRouter / Gemini's OpenAI-compatible endpoints
- No database. Session metadata lives in Vercel Blob (or memory locally); rows are re-read from the stored file when needed.

## Project layout

```
src/lib/
  parse.ts, clean.ts, keys.ts     loading, cleaning, key normalisation
  relationships.ts                PK/FK inference
  semantic-model.ts               tables / measures / dimensions menu, long-format & QC-flag detection
  schema-linking.ts               question words → columns, join paths, schema pruning
  llm.ts, providers.ts            planner / explainer prompts, model chains, key detection
  compile-selection.ts            menu selection → executable plan (joins, sub-plans)
  plan-validator.ts               deterministic repairs
  answer-check.ts                 "can this plan answer the question?" rules + retry feedback
  query-engine.ts                 filters, joins, aggregates, correlation
  merge-results.ts                multi-fact merge
  dataset-summary.ts              the plain-language file card
src/app/api/{upload,query,dataset}   routes
src/components                        UI
scripts/                              generators and offline test suites (see below)
test-data/                            three validation sets with computed answer keys
```

## Tests

Offline, no model calls — these run in a few seconds and guard the engine:

```bash
npx tsx scripts/run-answer-check.ts        # the guard-rail rules
npx tsx scripts/run-selection-compiler.ts  # compiler + engine against the SaaS set's key
npx tsx scripts/run-golden-v3.ts           # the hardest sensor-data questions, engine only
npx tsx scripts/run-validator-regression.ts
npx tsx scripts/run-relationship-regression.ts
npx tsx scripts/run-adversarial-suite.ts   # fan-out, N:M, same-named columns
npx tsx scripts/run-schema-linking.ts
npx tsx scripts/run-scale-benchmark.ts     # 25 synthetic files, timings
```

Live, against the dev server (uses your model quota):

```bash
npx tsx scripts/run-tier2-v2.ts                          # SaaS set, Tier 2
SET=validation-v3 TIERS=2,3 npx tsx scripts/run-tier2-v2.ts   # sensor set, cross-file + charts
ONLY=2.3,2.4 ...                                         # a subset
```

Each live question writes a full trace to `test-data/<set>/logs/<label>/`.

The three validation sets (`test-data/validation`, `validation-v2`, `validation-v3`) are generated by `scripts/gen-*.ts` with fixed seeds; every expected answer in their `TEST_QUESTIONS*.md` is computed by the generator, not typed.

## Known limits

- One model tier's consistency is the main source of variance. On the free tiers, the same question can get a different plan on different runs; the second-draft check reduces but does not remove that.
- Questions that need a time bucket matched against period labels in another file ("did each region hit its Q1 target") are not handled yet.
- A histogram is drawn over raw values; there is no binning step.
- Free providers rate-limit and occasionally time out. The chain skips a failing model for a while and moves on, but if every model is down the app says so instead of answering.

## Credits

Design ideas borrowed (no code): Looker's symmetric aggregates and dbt MetricFlow for the multi-fact merge; inclusion-dependency discovery (Papenbrock et al.) for key inference; the text-to-SQL "plan, verify, repair" pattern (DIN-SQL, MAC-SQL) for the retry loop. Full list in `docs/DataLens-References-and-Prior-Art.pdf`.
