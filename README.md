# DataLens

Upload CSV / Excel files, ask questions in plain English, get computed answers with charts and a full trace. The language model plans the query; a deterministic engine runs it.

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

Production build: `npm run build && npm run start`

## Environment

| Variable | When | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | one key required | free key: https://openrouter.ai/keys — `…2`, `…3` rotate |
| `GEMINI_API_KEY` | one key required | free key: https://aistudio.google.com/apikey |
| `BLOB_READ_WRITE_TOKEN` | Vercel only | Blob store token |
| `NEXT_PUBLIC_BLOB_CLIENT_UPLOADS` | Vercel only | `1` — browser uploads straight to Blob (functions cap requests at ~4.5 MB) |

Optional: `LLM_PROVIDER`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `PLAN_CONSENSUS` — see `.env.example`.

## Deploy to Vercel

1. Import the repo in Vercel (root directory = repo root).
2. Storage → create a Blob store and connect it (adds `BLOB_READ_WRITE_TOKEN`).
3. Environment Variables: `NEXT_PUBLIC_BLOB_CLIENT_UPLOADS=1` plus your model key(s).
4. Redeploy (env vars are compiled in at build time).

## Tests

Offline, no model calls:

```bash
npx tsx scripts/run-answer-check.ts
npx tsx scripts/run-selection-compiler.ts
npx tsx scripts/run-golden-v3.ts
npx tsx scripts/run-validator-regression.ts
npx tsx scripts/run-relationship-regression.ts
npx tsx scripts/run-adversarial-suite.ts
npx tsx scripts/run-schema-linking.ts
npx tsx scripts/run-scale-benchmark.ts
```

Live, against `npm run dev` (uses model quota), traces land in `test-data/<set>/logs/`:

```bash
npx tsx scripts/run-tier2-v2.ts                                   # validation-v2, Tier 2
SET=validation-v3 TIERS=2,3 npx tsx scripts/run-tier2-v2.ts       # sensor set
SET=validation TIERS=2 ONLY=2.1,2.3 npx tsx scripts/run-tier2-v2.ts
```

Validation sets and their computed answer keys: `test-data/validation`, `validation-v2`, `validation-v3` (`TEST_QUESTIONS*.md`).

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind · Recharts · papaparse · xlsx · OpenAI SDK (OpenRouter / Gemini endpoints) · Vercel Blob

## Layout

```
src/lib/        parse & clean → relationships → semantic model → planner → compiler → validator → answer-check → engine
src/app/api/    upload, upload/blob, query, dataset
src/components/ UI
scripts/        data generators and test suites
test-data/      validation sets with answer keys
```
