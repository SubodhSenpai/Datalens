# DataLens — write-up

*FDE take-home · Subodh · September 2026*

## Approach

A language model reads a question well and adds up 30,000 rows badly. So the model only writes a small plan — tables, fields, filters, joins, aggregations — and a deterministic engine computes the answer. The plan, every correction, the joins and the pandas equivalent are shown with the result, so a wrong number can be traced.

Around that core:

- **Loading that survives real exports** — `₹4,80,02,573.75`, `9.5 lakh`, `(500)`, `12%`, `N/A` blanks, three date shapes, `-999` codes, `TOTAL` rows, `Active`/`active`. Every fix is reported on the file card.
- **Joins found without naming them** — keys inferred from uniqueness and value inclusion; a `status` column shared by five files is not a join.
- **The model picks from a menu** of measures and dimensions; the compiler builds the joins. Two fact tables are aggregated separately and merged, never row-joined.
- **Answer-check with retry** — ten structural rules (total asked but rows returned, named value not filtered, "in both periods" without a `having`, a rate summed beside its quantity, "highest" sorted ascending …) send feedback to the model, at most twice. Cross-file questions get a second independent draft; disagreement is reconciled.

## Key decisions

- Free open-source models, keys in rotation, and **no answer when no model is reachable** — never a keyword fallback.
- When a question shape kept failing, **extend the plan language**, not the prompt: column-vs-column filters, count-if measures, post-aggregation shares, multi-hop anti-joins — each with an offline golden test.
- **Guard rules need two signals** — a word match alone misfired ("maintenance visits" vs a `Maintenance` status).

## Evaluation

Three generated data sets, fixed seeds, every expected answer computed by the generator, each with deliberate traps.

| Set | Traps | Single-file | Cross-file |
|---|---|---|---|
| v1 HR & sales (12 files) | messy headers, `9.5 lakh`, semicolon CSV, TOTAL row | 11 / 11 | 13 / 15 |
| v2 SaaS billing (4 files, 6 tables) | duplicate customer, two `amount` columns, title rows, DD/MM dates | 11 / 11 | 18 / 21 |
| v3 Environmental sensors (32k readings) | `-999` codes, Suspect flags, °F/°C mix, limits in another sheet | 11 / 11 | 20 / 24 |

Graded strictly: **cross-file 51 / 60 = 85 %** (95 % counting defensible readings), single-file 33 / 33, guardrail tier 9 / 12. Charts on every grouped or trend result. Remaining misses: model variance on the weakest free tier, provider timeouts, and two shapes not built (a date bucket matched to period labels; binned histograms). Eight offline suites run without a model and separate engine bugs from model variance.

## What I'd build next

1. **Bring your own paid model** — all calls already go through one OpenAI-compatible provider table (`providers.ts`), and a key pasted in the UI stays in the browser and is used only for that user; today that covers OpenRouter and Gemini. Adding OpenAI, Mistral or Groq is one row in the table, Anthropic and Azure a small adapter, plus a per-user model picker (paid tiers remove most of the remaining variance) and per-question cost beside the trace.
2. **Plan cache and provider health** — reuse plans for repeated questions; skip a model for ten minutes after repeated 503s.
3. **Chained plans** — a plan that reads another plan's output covers the last missing shapes.
4. **Data-contract defaults** — quality-flag and unit policies applied on load, with an opt-out.
5. **Follow-up context** — carry the previous plan into "now only for June".
6. **A compiler symbol table** — resolve column identity once, not by name at each stage.
