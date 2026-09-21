# DataLens — write-up

*FDE take-home · Subodh · September 2026*

## Approach

"Correct" had to mean *computed*, not *generated*: a language model reads a question well and adds up 30,000 rows badly. So the model only produces a small structured plan — tables, fields, filters, joins, aggregations — and a deterministic engine runs it. The plan, every correction made to it, the joins and the pandas equivalent are shown with the answer, so a wrong number is diagnosable rather than mysterious. Around that core:

- **Loading that survives real exports** — `₹4,80,02,573.75`, `9.5 lakh`, `(500)`, `12%`; `N/A`/`-`/`#N/A` blanks; three date shapes with day/month order decided per column; `-999` missing codes; `TOTAL` rows; `Active`/`active` variants. Every intervention is reported on the file card.
- **Relationship inference** from uniqueness and value inclusion — joins are found without the user naming them, and a `status` column shared by five files does *not* become one.
- **A semantic menu** the model picks from; the compiler derives the base table, join path and post-join names. Two fact tables are aggregated separately and merged, never row-joined.
- **A structural answer-check with retry** — a total asked but rows returned, a named value never filtered, "in both periods" without a `having`, a per-unit rate summed beside its quantity, "highest" sorted ascending — each sends concrete feedback to the model, at most twice. Cross-file questions also get a second independent draft; disagreement is reconciled.

## Key decisions

- **Open-source models on free tiers, keys in rotation, and no answer when no model is reachable** — never a keyword fallback. Gemini was added later behind the same interface; the key's shape picks the provider.
- **Extend the plan language rather than the prompt** when a shape kept failing: column-vs-column comparisons, conditional measures (count-if), post-aggregation derives (shares), multi-hop anti-joins — each with an offline golden test.
- **Guard rules need two signals.** A lexical match alone misfired ("maintenance visits" vs a `Maintenance` status); every rule now also needs a structural fact.

## Evaluation

Three generated validation sets in different domains, fixed seeds, every expected answer *computed by the generator* and each set carrying deliberate traps:

| Set | Files / tables | Traps | Cross-file Qs |
|---|---|---|---|
| v1 HR & sales | 12 / 14 | messy headers, `9.5 lakh`, semicolon CSV, TOTAL row | 15 |
| v2 SaaS billing | 4 / 6 | duplicate customer, two `amount` columns, title rows, DD/MM dates | 21 |
| v3 Environmental sensors | 4 / 6 (32k readings) | `-999` codes, Suspect flags, °F/°C mix, limits in another sheet | 24 |

Latest complete live runs, graded strictly (value must match the key):

- **Cross-file: 51 / 60 exact = 85 %** (v1 87 %, v2 90 %, v3 79 %); 95 % counting defensible readings such as revenue without an unstated discount.
- **Single-file: 33 / 33.** Edge cases (ambiguity, off-topic, mutation requests, no data for the period): 9 / 12.
- Charts on every grouped comparison or trend — 35 of 45 cross-file results; the rest are lists or single values.
- Misses left: model consistency on the weakest free tier, three provider timeouts, and two shapes not built (a date bucket matched to period labels in another file; binned histograms).

Eight offline suites (guard rules, compiler, golden plans, validator, relationships, adversarial joins, schema linking, a 25-file scale benchmark) run in seconds without a model and separate engine regressions from model variance. The golden suite holds the hardest sensor questions as correct plans — exceedance counts and shares against a limit from another sheet, the peak with its timestamp, a two-hop anti-join, a temperature–ozone correlation paired by station and time (r = 0.357, n = 4,405, the generator's own figure).

## Bringing your own model

Every model call goes through one OpenAI-compatible interface (`providers.ts`: base URL, model chain, key shape, token budget). Today that table holds OpenRouter's free open-source models and Google Gemini; a key pasted in the UI is recognised by its shape, kept in the browser, and used only for that user — so each user already spends their own quota.

Adding a paid provider is one row in that table, not new code paths: OpenAI (`sk-…`), Anthropic (`sk-ant-…`), Mistral, Groq and Azure OpenAI all speak the same chat-completions shape or ship an OpenAI-compatible endpoint. What I would add on top: a model picker per user (paid tiers remove the 429/503 variance that causes most remaining misses), per-question cost shown next to the trace, and an organisation key stored server-side with per-user rate limits — so a team can run on one paid account while a visitor still brings their own key.

## What I'd build next

1. **Plan cache and provider health** — cache plans by schema fingerprint + normalised question; skip a model for ten minutes after repeated 503s.
2. **Chained plans** (a plan reading another plan's output) — the last unexpressible shapes, including period-label matching, fall out of this.
3. **Data-contract defaults** — quality-flag and unit policies applied deterministically on load, with an opt-out, instead of relying on the model to remember them.
4. **Follow-up context** — carry the previous plan into the next question ("now only for June").
5. **A compiler symbol table** so column identity is resolved once rather than matched by name at each stage — the source of two bugs fixed this week.
