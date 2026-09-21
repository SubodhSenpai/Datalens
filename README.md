<h1 align="center">DataLens</h1>

<p align="center">Ask plain-English questions across uploaded CSV / Excel files. The model plans the query; a deterministic engine computes the answer, with a chart and a full trace.</p>

<p align="center">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js_16-000000?logo=nextdotjs&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React_19-20232A?logo=react&logoColor=61DAFB">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind_4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="Recharts" src="https://img.shields.io/badge/Recharts-22B5BF?logo=chartdotjs&logoColor=white">
  <img alt="OpenRouter" src="https://img.shields.io/badge/OpenRouter-free_OSS_models-6E56CF">
  <img alt="Gemini" src="https://img.shields.io/badge/Google_Gemini-4285F4?logo=google&logoColor=white">
  <img alt="Vercel Blob" src="https://img.shields.io/badge/Vercel_Blob-000000?logo=vercel&logoColor=white">
</p>

## Run locally

Needs Node.js 20+ and git.

```bash
git clone https://github.com/SubodhSenpai/Datalens.git
cd Datalens
npm ci
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
# put ONE model key in .env:  OPENROUTER_API_KEY=sk-or-...   or   GEMINI_API_KEY=AIza...
npm run dev                   # http://localhost:3000
```

Try it: upload the four files in `test-data/validation-v2/` and ask *Total invoiced amount by industry*.

| Variable | When | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | one key required | https://openrouter.ai/keys — free open-source models only; `…2`, `…3` rotate |
| `GEMINI_API_KEY` | one key required | https://aistudio.google.com/apikey |
| `BLOB_READ_WRITE_TOKEN` | hosted only | Vercel Blob token |
| `NEXT_PUBLIC_BLOB_CLIENT_UPLOADS` | hosted only | `1` — browser uploads straight to Blob (serverless request cap ≈ 4.5 MB) |

Optional: `LLM_PROVIDER`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `PLAN_CONSENSUS` — see `.env.example`.

## Validation

Three generated data sets, fixed seeds, every expected answer computed by the generator (`scripts/gen-*.ts`, keys in `test-data/*/TEST_QUESTIONS*.md`). Graded strictly: the value must match the key.

| Set | Traps built in | Single-file | Cross-file (exact) |
|---|---|---|---|
| v1 HR & sales — 12 files | padded/BOM headers, `9.5 lakh`, semicolon CSV, TOTAL row | 11 / 11 | 13 / 15 |
| v2 SaaS billing — 4 files, 6 tables | duplicate customer, two `amount` columns, title rows, DD/MM dates | 11 / 11 | 18 / 21 |
| v3 Environmental sensors — 4 files, 32k readings | `-999` codes, Suspect flags, °F/°C mix, limits in another sheet | 11 / 11 | 20 / 24 |
| **Total** | | **33 / 33** | **51 / 60 = 85 %** (95 % counting defensible readings) |

Ambiguity / guardrail tier (off-topic, mutation requests, no data for the period, mean-vs-median): 9 / 12. Charts on 35 of 45 cross-file results; the rest are lists or single values. Remaining misses: model consistency on the weakest free tier, provider timeouts, and two shapes not built (date bucket matched to period labels in another file; binned histograms).

## Techniques

| Stage | Technique | Ref. |
|---|---|---|
| Loading | placeholder blanks, formatted numbers (`₹4,80,02,573.75`, `(500)`, `12%`, `9.5 lakh`), per-column day/month order, missing-value codes (`-999`), summary-row exclusion, spelling unification — each reported | [1] |
| Relationships | PK/FK inference from uniqueness + inclusion dependencies, cardinality classes, key-ness gate against low-cardinality columns | [2], [3] |
| Semantic model | tables / measures / dimensions menu the model selects from; long-format (`parameter`/`unit` → `value`) and QC-flag detection | [4] |
| Schema linking | question → column matching (stem, plural, abbreviation), BFS join paths, schema pruning to linked tables + one hop | [5], [6] |
| Compilation | join path, post-join naming, column-vs-column filters, conditional measures, post-aggregation derives, multi-hop anti-joins | — |
| Multi-fact | one sub-plan per fact table, merged on shared dimensions (no chasm/fan-trap row joins) | [7], [8] |
| Verification | deterministic validator + 10 structural answer-check rules, feedback retry ≤ 3 | [9], [10] |
| Consensus | second independent draft on cross-file questions, compared on computed signature, reconciled on disagreement | [11] |
| Charts | type chosen from question and result shape; default bar/line for grouped results | [12] |

## Tests

Offline, no model calls:

```bash
npx tsx scripts/run-answer-check.ts          npx tsx scripts/run-validator-regression.ts
npx tsx scripts/run-selection-compiler.ts    npx tsx scripts/run-relationship-regression.ts
npx tsx scripts/run-golden-v3.ts             npx tsx scripts/run-adversarial-suite.ts
npx tsx scripts/run-schema-linking.ts        npx tsx scripts/run-scale-benchmark.ts
```

Live, against `npm run dev` (uses model quota); traces in `test-data/<set>/logs/`:

```bash
npx tsx scripts/run-tier2-v2.ts                                   # validation-v2, Tier 2
SET=validation-v3 TIERS=2,3 npx tsx scripts/run-tier2-v2.ts       # sensor set
SET=validation TIERS=2 ONLY=2.1,2.3 npx tsx scripts/run-tier2-v2.ts
```

## Layout

```
src/lib/        parse & clean → relationships → semantic model → planner → compiler → validator → answer-check → engine
src/app/api/    upload, upload/blob, query, dataset
src/components/ UI
scripts/        data generators and test suites
test-data/      validation sets with answer keys
```

## References

1. I. F. Ilyas, X. Chu, *Data Cleaning*, ACM Books, 2019.
2. T. Papenbrock, S. Kruse, J.-A. Quiané-Ruiz, F. Naumann, "Divide & Conquer-based Inclusion Dependency Discovery," *PVLDB* 8(7), 2015.
3. Y. He et al., "Auto-BI: Automatically Build BI-Models Leveraging Local Join Prediction and Global Schema Graph," *PVLDB* 16(10), 2023.
4. dbt Labs, "How the dbt Semantic Layer works," 2024 — https://www.getdbt.com/blog/how-the-dbt-semantic-layer-works
5. H. Li, J. Zhang, C. Li, H. Chen, "RESDSQL: Decoupling Schema Linking and Skeleton Parsing for Text-to-SQL," *AAAI*, 2023.
6. S. Talaei et al., "CHESS: Contextual Harnessing for Efficient SQL Synthesis," arXiv:2405.16755, 2024.
7. Google Cloud, "Looker: Understanding symmetric aggregates" — https://cloud.google.com/looker/docs/best-practices/understanding-symmetric-aggregates
8. Sisense, "Chasm and fan traps" — https://docs.sisense.com/main/SisenseLinux/chasm-and-fan-traps.htm
9. M. Pourreza, D. Rafiei, "DIN-SQL: Decomposed In-Context Learning of Text-to-SQL with Self-Correction," *NeurIPS*, 2023.
10. B. Wang et al., "MAC-SQL: A Multi-Agent Collaborative Framework for Text-to-SQL," *COLING*, 2025.
11. X. Wang et al., "Self-Consistency Improves Chain of Thought Reasoning in Language Models," *ICLR*, 2023.
12. W. S. Cleveland, R. McGill, "Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods," *J. Amer. Statist. Assoc.* 79(387), 1984.
