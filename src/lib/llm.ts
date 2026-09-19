import OpenAI from "openai";
import { AggregateFn, ColumnSchema, FilterOp, QueryPlan } from "./types";
import { RelationshipRecord } from "./session-store";
import { AmbiguityWarning } from "./data-dictionary";

export interface DatasetSchemaContext {
  id: string;
  name: string;
  rowCount: number;
  columns: ColumnSchema[];
}

/**
 * Optional out-param for observing an LLM call from the outside: the exact
 * prompt sent, the raw text that came back, which model in the chain
 * actually answered, and whether it fell back to the deterministic planner.
 * Passed in and filled in place so existing callers that don't care are
 * unaffected.
 */
export interface LlmCallTrace {
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  rawResponse?: string;
  ms?: number;
  usedHeuristicFallback?: boolean;
  fallbackReason?: string;
}

// Open-source models served via OpenRouter (OpenAI-compatible API), per the
// assignment's "use open-source AI models" constraint. The primary model is
// configurable (OPENROUTER_MODEL) — a fully-free ":free" model sits on a
// shared, congested pool and can be rate-limited or out of capacity at any
// moment. Rather than let that take the planner down to the heuristic
// fallback (accurate but far weaker), each free-tier candidate below is
// tried in order before giving up.
const MODEL = process.env.OPENROUTER_MODEL ?? "qwen/qwen-2.5-7b-instruct";
const FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "deepseek/deepseek-v4-flash-0731:free",
  "z-ai/glm-5.2:free",
].filter((m) => m !== MODEL);
const MODEL_CHAIN = [MODEL, ...FALLBACK_MODELS];

// OpenRouter's free-tier rate limits are tracked per API key — a second
// (or third, ...) key under OPENROUTER_API_KEY2, OPENROUTER_API_KEY3, ...
// gets its own independent rate-limit bucket, so cycling through them on a
// 429 is a real way to dodge shared-pool congestion, not just a retry in
// disguise.
//
// A deployment with no server-side key committed (so every visitor brings
// their own) passes `userApiKey` — sent by the client per-request, never
// persisted server-side — which is used EXCLUSIVELY instead of any env keys,
// so it's unambiguous whose credits/rate limits a query is spending.
function getClients(userApiKey?: string): OpenAI[] {
  if (userApiKey) return [new OpenAI({ apiKey: userApiKey, baseURL: "https://openrouter.ai/api/v1" })];

  const keys = [process.env.OPENROUTER_API_KEY];
  for (let i = 2; ; i++) {
    const key = process.env[`OPENROUTER_API_KEY${i}`];
    if (!key) break;
    keys.push(key);
  }
  return keys
    .filter((k): k is string => Boolean(k))
    .map((apiKey) => new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }));
}

// Not all OpenRouter-hosted providers support strict `response_format:
// json_object`, so this relies on the prompt instructing JSON-only output
// plus extractJson()'s regex fallback below, rather than a mode that could
// be silently unsupported per model/provider.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1500;

function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit/i.test(msg);
}

// Ordering matters here: exhaust every API key on the PRIMARY model first
// (each key has its own rate-limit bucket, so a second key is a real way
// past a 429 on the model you actually asked for) before dropping down to
// a different fallback model at all.
async function completeJson(
  clients: OpenAI[],
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<{ text: string; model: string }> {
  let lastErr: unknown;
  for (const model of MODEL_CHAIN) {
    for (const client of clients) {
      try {
        const text = await completeJsonWithModel(client, model, system, userMessage, maxTokens);
        return { text, model };
      } catch (err) {
        lastErr = err;
        // Only move on to the next key/model for capacity-related failures
        // (rate limit, out of credits/capacity) — anything else (bad
        // request, auth) will fail identically everywhere, so there's no
        // point burning the whole chain on it.
        if (!isRateLimited(err) && !isCapacityError(err)) throw err;
        console.error(`completeJson: "${model}" unavailable (${err instanceof Error ? err.message : err}), trying next option.`);
      }
    }
  }
  throw lastErr;
}

function isCapacityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /402|insufficient credits|no.*instances|not available/i.test(msg);
}

async function completeJsonWithModel(client: OpenAI, model: string, system: string, userMessage: string, maxTokens: number): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS * attempt));
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        // Both callers (plan JSON, explanation JSON) want a consistent,
        // correct answer for a given input, not creative variety —
        // observed real run-to-run variance at default sampling (e.g. the
        // same join question sometimes used leftOn/rightOn correctly,
        // sometimes didn't), so pin to near-deterministic.
        temperature: 0,
        // Some free-tier models (e.g. Qwen's ":free" variant) default to an
        // internal "thinking" pass that eats the whole max_tokens budget as
        // reasoning tokens, leaving finish_reason "length" and an EMPTY
        // content field — a silent failure that looks like the model just
        // didn't answer. Turning reasoning off (where the provider supports
        // it) makes it answer directly instead. Not in the openai SDK's
        // types, so it's passed through as a plain extra body field;
        // providers that ignore it just fall back to default behavior.
        ...( { reasoning: { enabled: false } } as object),
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMessage },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (content) return content;
      // Some reasoning models put the answer in a non-standard "reasoning"
      // field instead of "content" when they run out of budget mid-thought —
      // salvage a trailing JSON object from it rather than treating this as
      // a total failure straight to the heuristic fallback.
      const reasoning = (response.choices[0]?.message as { reasoning?: string } | undefined)?.reasoning;
      return reasoning ?? "";
    } catch (err) {
      lastErr = err;
      // A free-tier shared pool returning 429 is transient congestion, not
      // a real failure — worth a couple of short retries before giving up
      // to the much weaker heuristic fallback.
      if (!isRateLimited(err) || attempt === RATE_LIMIT_RETRIES) throw err;
    }
  }
  throw lastErr;
}

// ─── Query Planner (Figure 4) ──────────────────────────────────────────────

export async function planQuery(
  question: string,
  datasets: DatasetSchemaContext[],
  relationships: RelationshipRecord[],
  ambiguities: AmbiguityWarning[] = [],
  userApiKey?: string,
  trace?: LlmCallTrace
): Promise<QueryPlan> {
  const clients = getClients(userApiKey);
  if (clients.length === 0) {
    if (trace) {
      trace.usedHeuristicFallback = true;
      trace.fallbackReason = "No API key configured (neither a server key nor one set in the browser), so the deterministic keyword planner ran instead of an LLM.";
    }
    return heuristicPlan(question, datasets, relationships);
  }

  const schemaContext = datasets.map((d) => ({
    id: d.id,
    name: d.name,
    rowCount: d.rowCount,
    columns: d.columns.map((c) => ({ name: c.name, type: c.type })),
  }));

  const system = `You are a query planner for a tabular data analysis tool. Given a user's natural-language question and the schema of one or more datasets (plus detected column relationships between them), output ONLY a JSON object (no markdown, no prose) matching this TypeScript type:

type QueryPlan = {
  datasetId: string;            // id of the base dataset from the list given
  joins?: { datasetId: string; on?: string; leftOn?: string; rightOn?: string; type?: "inner"|"left" }[]; // use when the question needs data from more than one dataset. Use "on" ONLY when both datasets name the join column identically. If a relationship below has different columnA/columnB names (e.g. matched by value overlap, not name), you MUST use leftOn (the base dataset's column name) + rightOn (the joined dataset's column name) instead — do not invent a column name that doesn't exist in one of the datasets, that silently produces garbage results. A question can need data from a THIRD dataset that has no direct relationship to the base — e.g. base is an orders table with only a store id, and the question wants a "region name" that lives in a regions table connected only through a stores table. In that case list BOTH joins: one from the base to the intermediate dataset, then one from the intermediate dataset's key to the third dataset (leftOn/rightOn can reference a column that only exists after the FIRST join has been applied).
  derive?: { as: string; expr: string }[]; // computed row-level columns, evaluated before filters/groupBy/aggregations. expr is ARITHMETIC ONLY over existing numeric column names: + - * / ( ) and number literals — no functions, no strings. Use this whenever the question needs a value that isn't already a literal column but is a straightforward formula over ones that exist, e.g. "revenue" from quantity/unit_price/discount_pct, or "profit" from a revenue-like derive minus a cost column. Never invent a number outside this expression grammar.
  select?: string[];            // columns to include in the output, omit for all
  filters?: { column: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"; value: string|number|boolean }[];
  dateBucket?: { column: string; granularity: "day"|"month"|"year"; as?: string }; // use for trend/time-series questions to bucket a date column before grouping
  groupBy?: string[];
  aggregations?: { column: string; fn: "sum"|"avg"|"count"|"min"|"max"; as?: string }[];
  correlate?: { columnX: string; columnY: string }; // set this whenever the question asks about correlation / relationship strength between two numeric columns — this computes an actual Pearson coefficient, which a chart alone cannot do
  sort?: { column: string; direction: "asc"|"desc" }[];
  limit?: number;
  chartType?: "bar"|"stacked-bar"|"dot"|"line"|"area"|"pie"|"scatter"|"histogram"|"radar"|"treemap"|"heatmap"|"none";
  chartX?: string;              // column for x-axis / category, required if chartType != "none"
  chartY?: string[];            // column(s) for y-axis / value, required if chartType != "none"
  reasoning?: string;           // one sentence on why this plan answers the question
};

A question comparing multiple values of the SAME column ("active vs exited", "B2B vs B2C", "compare X and Y") wants a groupBy on that column, NOT a filter — a plan can only have one value per "eq" filter on a column, so filtering "status = active" AND "status = exited" at once matches zero rows. GroupBy shows every value (including ones not named) in one result; only add a filter when the question wants to see ONE value/subset, not when it's comparing several.

Only reference columns that exist in the given schema (post-join, joined-in columns keep their original name unless it collides with a base column, in which case it's prefixed with "<joinedDatasetName>_"). Pick sensible defaults: totals/averages/counts always need an "aggregations" entry (never leave a "total"/"average" question as an unaggregated row dump); "by <dimension>" or "each <dimension>" implies groupBy; "top/bottom N" implies sort+limit; chartType "none" only for a single scalar answer. Chart choice: bar for comparing a handful of categories, dot instead of bar when there are more than ~12 categories, line for trends over time, area for cumulative/running totals over time, pie for a proportion breakdown of 5 or fewer categories, treemap for a proportion breakdown of 6+ categories, histogram for the distribution of one numeric column, scatter for the relationship between two numeric columns (pair with "correlate"), radar for comparing several metrics across a few entities, heatmap for a value across two categorical dimensions at once.

For a trend/time-series question, you MUST bucket the date column with dateBucket before grouping by it — never groupBy a raw date column directly, since every row has a distinct timestamp and that produces one group per row instead of a real trend. Example: question "show the monthly revenue trend", dataset has date column "order_date" and numeric column "amount":
{"datasetId":"<id>","dateBucket":{"column":"order_date","granularity":"month","as":"order_date_month"},"groupBy":["order_date_month"],"aggregations":[{"column":"amount","fn":"sum","as":"total_amount"}],"sort":[{"column":"order_date_month","direction":"asc"}],"chartType":"line","chartX":"order_date_month","chartY":["total_amount"]}

"Top/bottom N" questions come in two different shapes — do not confuse them:
1. "Top N <rows> by <column>" (the rows themselves are already what's being ranked, e.g. "top 10 products by unit price") needs ONLY select+sort+limit — no "aggregations" and no "groupBy" at all, since there is nothing to summarize, just rows to rank and truncate: {"datasetId":"<id>","select":["product_name","unit_price"],"sort":[{"column":"unit_price","direction":"desc"}],"limit":10,"chartType":"bar","chartX":"product_name","chartY":["unit_price"]}
2. "Top N <categories> by <measure>" (ranking groups by a computed summary, e.g. "top 10 categories by total revenue") needs groupBy+aggregations+sort+limit together. Adding "aggregations" without "groupBy" collapses ALL rows into a single summary row — never do that for a per-row ranking question, it silently turns a 10-row answer into 1.

If a dataset has columns like "quantity", "unit_price" and "discount_pct" (as a percentage, e.g. 10 meaning 10%) but no literal "revenue"/"total_amount"/"sales" column, "total revenue" means derive it first: {"derive":[{"as":"revenue","expr":"quantity * unit_price * (1 - discount_pct / 100)"}],"aggregations":[{"column":"revenue","fn":"sum","as":"total_revenue"}]}. Do the same for any other value the question names that is clearly a simple formula over existing numeric columns rather than typing a bare aggregation over a column that doesn't exist.

For a cross-dataset question, check the Relationships list below first — each entry gives columnA (in datasetIdA) and columnB (in datasetIdB) plus how it was detected ("name" = identical column names; "value-overlap" = the column names differ but their actual values substantially overlap, e.g. a "country" column and a "nation" column both containing the same country names). Only join on a relationship that's actually listed; if no relationship connects the datasets you need, say so in "reasoning" and answer from the single dataset you can, rather than guessing a join key.

Three-dataset example — this pattern applies whenever the value you need to group by lives TWO joins away from the base dataset, regardless of what the datasets are actually called: base "orders" (columns order_id, amount, store_id) needs to be broken down by "region name", which only exists in "regions" (region_id, region_name) — and orders has no region_id at all, only "stores" (store_id, region_id) connects the two:
{"datasetId":"<orders id>","joins":[{"datasetId":"<stores id>","on":"store_id"},{"datasetId":"<regions id>","on":"region_id"}],"groupBy":["region_name"],"aggregations":[{"column":"amount","fn":"sum","as":"total_amount"}],"chartType":"bar","chartX":"region_name","chartY":["total_amount"]}
Do NOT join a dataset that the question doesn't actually need data from, even if a relationship to it exists — an extra join multiplies every row (and every sum) by however many matching rows it adds. Only include a join whose columns you will actually filter/groupBy/aggregate/select/chart by.

This system only aggregates and summarizes data that already exists — it has no forecasting, prediction, or trend-extrapolation capability. If asked to predict, forecast, or project a future value, do NOT invent one: plan the closest honest historical answer instead (e.g. the actual past trend), never name an aggregation "predicted_x"/"forecast_x", and use "reasoning" to note that forecasting isn't supported so the explanation reflects that limitation rather than presenting a fabricated number as a real prediction.`;

  const ambiguityLine = ambiguities.length
    ? `\n\nHeads up — this question's wording could mean more than one column:\n${ambiguities
        .map((a) => `- "${a.concept}": ${a.candidates.map((c) => `"${c.column}" (${c.datasetName})`).join(" or ")}`)
        .join("\n")}\nPick the one that most literally matches the question, and say which one you picked (and that alternatives exist) in "reasoning".`
    : "";
  const userMessage = `Datasets:\n${JSON.stringify(schemaContext, null, 2)}\n\nRelationships:\n${JSON.stringify(relationships, null, 2)}${ambiguityLine}\n\nQuestion: ${question}`;

  if (trace) {
    trace.systemPrompt = system;
    trace.userPrompt = userMessage;
  }

  const started = Date.now();
  try {
    const { text, model } = await completeJson(clients, system, userMessage, 600);
    if (trace) {
      trace.model = model;
      trace.rawResponse = text;
      trace.ms = Date.now() - started;
    }
    const plan = extractJson<QueryPlan>(text);
    if (!plan || !plan.datasetId) {
      if (trace) {
        trace.usedHeuristicFallback = true;
        trace.fallbackReason = "The model's response could not be parsed as a valid plan (no JSON object with a datasetId), so the deterministic keyword planner ran instead.";
      }
      return heuristicPlan(question, datasets, relationships);
    }
    return plan;
  } catch (err) {
    // The provider (rate limit, out-of-credits, transient outage) failing
    // shouldn't take the whole app down — degrade to the deterministic
    // keyword planner rather than surfacing a raw API error to the user.
    console.error("planQuery: OpenRouter call failed, falling back to heuristic planner:", err);
    if (trace) {
      trace.ms = Date.now() - started;
      trace.usedHeuristicFallback = true;
      trace.fallbackReason = `Every model/key in the chain failed (${err instanceof Error ? err.message : String(err)}), so the deterministic keyword planner ran instead.`;
    }
    return heuristicPlan(question, datasets, relationships);
  }
}

// ─── Result Explanation (Figure 8) ─────────────────────────────────────────

export async function explainResults(
  question: string,
  resultRows: Record<string, unknown>[],
  columns: string[],
  correlation?: { columnX: string; columnY: string; coefficient: number; sampleSize: number; interpretation: string },
  unsupportedConcepts: string[] = [],
  userApiKey?: string,
  trace?: LlmCallTrace
): Promise<{ explanation: string; followUpSuggestions: string[] }> {
  const clients = getClients(userApiKey);
  if (clients.length === 0) {
    if (trace) {
      trace.usedHeuristicFallback = true;
      trace.fallbackReason = "No API key configured, so a plain templated summary was used instead of an LLM explanation.";
    }
    return heuristicExplanation(question, resultRows, columns);
  }

  const system = `You explain data query results in plain English for a business user. Output ONLY a JSON object: { "explanation": string, "followUpSuggestions": string[] }. Keep the explanation to 2-4 sentences, reference concrete numbers from the data, and suggest 2-3 natural follow-up questions.

You are only ever shown a PREVIEW of the result (at most 20 rows) — the exact total row count is given separately and is the only count you may state; never estimate or imply a total from how many preview rows you can see.

If a "correlation" value is given below, you MUST state its exact coefficient and interpretation as computed — do not independently guess the relationship's strength or direction from the row preview, and do not contradict the given coefficient's sign.

If the question asks for something this data cannot support — forecasting/predicting future periods, causation, or anything not directly answerable from the rows and columns given — say so plainly instead of inventing a plausible-sounding number.`;

  const preview = resultRows.slice(0, 20);
  const correlationLine = correlation
    ? `\nCorrelation (already computed, do not recompute or contradict): r=${correlation.coefficient} between "${correlation.columnX}" and "${correlation.columnY}" — ${correlation.interpretation}, n=${correlation.sampleSize}.`
    : "";
  const limitsLine = unsupportedConcepts.length
    ? `\n\nTHE DATA CANNOT ANSWER PART OF THIS QUESTION:\n${unsupportedConcepts.map((c) => `- ${c}`).join("\n")}\nYou MUST lead the explanation by stating this plainly. Do not present any number as if it were the unavailable quantity, do not infer it from a related column, and do not name specific rows as examples of it. Explain only what the returned columns actually measure.`
    : "";
  const userMessage = `Question: ${question}\nColumns: ${columns.join(", ")}\nTotal result rows: ${resultRows.length}\nResult rows (preview, first ${preview.length} of ${resultRows.length}): ${JSON.stringify(preview)}${correlationLine}${limitsLine}`;

  if (trace) {
    trace.systemPrompt = system;
    trace.userPrompt = userMessage;
  }

  const started = Date.now();
  try {
    const { text, model } = await completeJson(clients, system, userMessage, 512);
    if (trace) {
      trace.model = model;
      trace.rawResponse = text;
      trace.ms = Date.now() - started;
    }
    const parsed = extractJson<{ explanation: string; followUpSuggestions: string[] }>(text);
    if (!parsed) {
      if (trace) {
        trace.usedHeuristicFallback = true;
        trace.fallbackReason = "The model's response could not be parsed as JSON, so a plain templated summary was used.";
      }
      return heuristicExplanation(question, resultRows, columns);
    }
    return parsed;
  } catch (err) {
    console.error("explainResults: OpenRouter call failed, falling back to heuristic explanation:", err);
    if (trace) {
      trace.ms = Date.now() - started;
      trace.usedHeuristicFallback = true;
      trace.fallbackReason = `Every model/key in the chain failed (${err instanceof Error ? err.message : String(err)}), so a plain templated summary was used.`;
    }
    return heuristicExplanation(question, resultRows, columns);
  }
}

// ─── Fallbacks (used when OPENROUTER_API_KEY is not configured) ───────────

// Keyword-driven fallback used only when OPENROUTER_API_KEY isn't configured.
// It intentionally covers the acceptance-criteria question shapes (totals,
// averages, filters, comparisons/groupBy, trends, cross-file joins) with
// plain regex/keyword matching rather than delegating any of that judgment
// to an LLM — real language understanding still requires the real planner.
function heuristicPlan(question: string, datasets: DatasetSchemaContext[], relationships: RelationshipRecord[]): QueryPlan {
  const base = pickBestDataset(question, datasets);
  if (!base) return { datasetId: "", limit: 50, chartType: "none" };

  const joinRel = findJoinableRelationship(question, base, datasets, relationships);
  const joinDataset = joinRel ? datasets.find((d) => d.id === joinRel.otherId) : undefined;
  const joins = joinRel && joinDataset
    ? [{ datasetId: joinDataset.id, leftOn: joinRel.leftOn, rightOn: joinRel.rightOn, type: "inner" as const }]
    : undefined;
  const columns = joinDataset ? [...base.columns, ...joinDataset.columns] : base.columns;

  const filters = parseFilters(question, columns);
  const agg = detectAggregation(question, columns);
  const groupByCol = detectGroupBy(question, columns);
  const dateCol = columns.find((c) => c.type === "date");
  const wantsTrend = /trend|over time|monthly|by month|by year|by date|timeline/i.test(question);
  const wantsCorrelation = /correlat|relationship between|\bvs\.?\b|\bversus\b/i.test(question);

  if (wantsCorrelation) {
    const numericCols = columns.filter((c) => c.type === "number");
    if (numericCols.length >= 2) {
      const [colX, colY] = numericCols;
      return {
        datasetId: base.id, joins,
        filters: filters.length ? filters : undefined,
        correlate: { columnX: colX.name, columnY: colY.name },
        chartType: "scatter", chartX: colX.name, chartY: [colY.name],
        reasoning: `Heuristic fallback (no OPENROUTER_API_KEY) — computed correlation between ${colX.name} and ${colY.name}.`,
      };
    }
  }

  if (wantsTrend && dateCol) {
    const numericCol = agg?.column ?? columns.find((c) => c.type === "number")?.name;
    const bucketCol = `${dateCol.name}_month`;
    const yCol = numericCol ? `${agg?.fn ?? "sum"}_${numericCol}` : "count";
    return {
      datasetId: base.id, joins,
      filters: filters.length ? filters : undefined,
      dateBucket: { column: dateCol.name, granularity: "month", as: bucketCol },
      groupBy: [bucketCol],
      aggregations: numericCol ? [{ column: numericCol, fn: agg?.fn ?? "sum", as: yCol }] : undefined,
      sort: [{ column: bucketCol, direction: "asc" }],
      chartType: "line", chartX: bucketCol, chartY: [yCol],
      reasoning: "Heuristic fallback (no OPENROUTER_API_KEY) — grouped by month to show a trend.",
    };
  }

  if (agg && groupByCol) {
    const asName = agg.column ? `${agg.fn}_${agg.column}` : agg.fn;
    return {
      datasetId: base.id, joins,
      filters: filters.length ? filters : undefined,
      groupBy: [groupByCol],
      aggregations: [{ column: agg.column ?? "", fn: agg.fn, as: asName }],
      sort: [{ column: asName, direction: "desc" }],
      chartType: "bar", chartX: groupByCol, chartY: [asName],
      reasoning: `Heuristic fallback (no OPENROUTER_API_KEY) — ${agg.fn} of ${agg.column ?? "rows"} grouped by ${groupByCol}.`,
    };
  }

  if (agg) {
    const asName = agg.column ? `${agg.fn}_${agg.column}` : agg.fn;
    return {
      datasetId: base.id, joins,
      filters: filters.length ? filters : undefined,
      groupBy: [],
      aggregations: [{ column: agg.column ?? "", fn: agg.fn, as: asName }],
      chartType: "none",
      reasoning: `Heuristic fallback (no OPENROUTER_API_KEY) — computed ${agg.fn} of ${agg.column ?? "rows"}.`,
    };
  }

  const wantsTop = /top|highest|most|largest/i.test(question);
  const wantsBottom = /bottom|lowest|least|smallest/i.test(question);
  const numericCol = columns.find((c) => c.type === "number");
  const stringCol = columns.find((c) => c.type === "string");
  const limitMatch = question.match(/\b(?:top|bottom|first)\s+(\d+)/i);
  const limit = limitMatch ? Number(limitMatch[1]) : (wantsTop || wantsBottom ? 10 : 50);

  if ((wantsTop || wantsBottom) && numericCol) {
    return {
      datasetId: base.id, joins,
      filters: filters.length ? filters : undefined,
      sort: [{ column: numericCol.name, direction: wantsBottom ? "asc" : "desc" }],
      limit,
      chartType: "bar", chartX: stringCol?.name ?? columns[0]?.name, chartY: [numericCol.name],
      reasoning: "Heuristic fallback (no OPENROUTER_API_KEY) — top/bottom-N by the most relevant numeric column.",
    };
  }

  return {
    datasetId: base.id, joins,
    filters: filters.length ? filters : undefined,
    limit: 50,
    chartType: "none",
    reasoning: "Heuristic fallback (no OPENROUTER_API_KEY) — filtered preview of the dataset.",
  };
}

function pickBestDataset(question: string, datasets: DatasetSchemaContext[]): DatasetSchemaContext | undefined {
  const q = question.toLowerCase();
  let best: DatasetSchemaContext | undefined;
  let bestScore = -1;
  for (const d of datasets) {
    let score = 0;
    if (q.includes(d.name.toLowerCase().replace(/\.(csv|xlsx?)$/i, ""))) score += 5;
    for (const c of d.columns) if (q.includes(c.name.toLowerCase())) score += 1;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function findJoinableRelationship(
  question: string,
  base: DatasetSchemaContext,
  datasets: DatasetSchemaContext[],
  relationships: RelationshipRecord[]
): { otherId: string; leftOn: string; rightOn: string } | undefined {
  const wantsCombined = datasets.length > 1 && (
    /combined|across (both|all|the)|both datasets|join|together|merge|correlat|relationship between/i.test(question) ||
    datasets.some((d) => d.id !== base.id && question.toLowerCase().includes(d.name.toLowerCase().replace(/\.(csv|xlsx?)$/i, "")))
  );
  if (!wantsCombined && datasets.length < 2) return undefined;

  // Prefer the highest-confidence relationship (exact name match beats a
  // value-overlap guess) if more than one connects these datasets.
  const candidates = relationships.filter(
    (r) =>
      (r.datasetIdA === base.id && datasets.some((d) => d.id === r.datasetIdB)) ||
      (r.datasetIdB === base.id && datasets.some((d) => d.id === r.datasetIdA))
  );
  if (candidates.length === 0) return undefined;
  const rel = candidates.reduce((best, r) => (r.confidence > best.confidence ? r : best));

  const baseIsA = rel.datasetIdA === base.id;
  return {
    otherId: baseIsA ? rel.datasetIdB : rel.datasetIdA,
    leftOn: baseIsA ? rel.columnA : rel.columnB,
    rightOn: baseIsA ? rel.columnB : rel.columnA,
  };
}

const COMPARATOR_PATTERNS: [RegExp, FilterOp][] = [
  [/greater than or equal to|at least/, "gte"],
  [/less than or equal to|at most/, "lte"],
  [/greater than|more than|over|above/, "gt"],
  [/less than|under|below/, "lt"],
  [/not equal to/, "neq"],
  [/equal to|equals|is exactly/, "eq"],
];

function parseFilters(question: string, columns: ColumnSchema[]): { column: string; op: FilterOp; value: number }[] {
  const q = question.toLowerCase();
  const filters: { column: string; op: FilterOp; value: number }[] = [];
  for (const col of columns) {
    if (col.type !== "number") continue;
    const escaped = col.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = q.match(new RegExp(`\\b${escaped}\\b[^0-9]{0,25}?(\\d+(?:\\.\\d+)?)`));
    if (!match || match.index === undefined) continue;
    const segment = q.slice(Math.max(0, match.index - 25), match.index + match[0].length);
    let op: FilterOp = "gt";
    for (const [pattern, mapped] of COMPARATOR_PATTERNS) {
      if (pattern.test(segment)) { op = mapped; break; }
    }
    filters.push({ column: col.name, op, value: Number(match[1]) });
  }
  return filters;
}

const AGG_PATTERNS: [RegExp, AggregateFn][] = [
  [/\btotal\b|\bsum\b/, "sum"],
  [/\baverage\b|\bavg\b|\bmean\b/, "avg"],
  [/how many|\bcount\b|number of/, "count"],
  [/\bminimum\b|\blowest\b|\bsmallest\b|\bmin\b/, "min"],
  [/\bmaximum\b|\bhighest\b|\blargest\b|\bmax\b/, "max"],
];

function detectAggregation(question: string, columns: ColumnSchema[]): { fn: AggregateFn; column?: string } | null {
  const q = question.toLowerCase();
  for (const [pattern, fn] of AGG_PATTERNS) {
    if (pattern.test(q)) {
      const mentioned = columns.find((c) => c.type === "number" && q.includes(c.name.toLowerCase()));
      return { fn, column: mentioned?.name ?? columns.find((c) => c.type === "number")?.name };
    }
  }
  return null;
}

function detectGroupBy(question: string, columns: ColumnSchema[]): string | undefined {
  const q = question.toLowerCase();
  const byMatch = q.match(/\b(?:by|per|for each|across each)\s+([a-z0-9_ ]+)/);
  if (byMatch) {
    const phrase = byMatch[1].trim();
    const col = columns.find((c) => c.type !== "number" && (phrase.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(phrase.split(" ")[0])));
    if (col) return col.name;
  }
  const col = columns.find((c) => (c.type === "string" || c.type === "boolean") && q.includes(c.name.toLowerCase()));
  return col?.name;
}

function heuristicExplanation(
  question: string,
  rows: Record<string, unknown>[],
  columns: string[]
): { explanation: string; followUpSuggestions: string[] } {
  const explanation = rows.length === 0
    ? `No rows matched "${question}".`
    : `Returned ${rows.length} row${rows.length === 1 ? "" : "s"} across ${columns.length} column${columns.length === 1 ? "" : "s"} for "${question}". (Set OPENROUTER_API_KEY for an AI-generated explanation.)`;
  return {
    explanation,
    followUpSuggestions: [],
  };
}

function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
