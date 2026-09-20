import OpenAI from "openai";
import { AggregateFn, ColumnSchema, FilterOp, QueryPlan } from "./types";
import { RelationshipRecord } from "./session-store";
import { joinPrefix } from "./query-engine";
import { AmbiguityWarning } from "./data-dictionary";
import { SchemaLink } from "./schema-linking";
import { SemanticModel, renderSemanticMenu } from "./semantic-model";
import { Selection, looksLikeSelection } from "./compile-selection";

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
  /** Why the keyword planner ran, when it did. */
  fallbackKind?: "no-key" | "unparseable" | "provider-error";
  /** The provider's finish_reason — "length" means the reply was cut off. */
  finishReason?: string;
}

/**
 * The model answered, but not with a plan. Thrown instead of silently
 * substituting the keyword planner, so the caller can ask the model again
 * with the unparseable text in hand — a model that wrote prose or truncated
 * its JSON usually gets it right when told exactly that.
 */
export class PlanParseError extends Error {
  constructor(
    public readonly rawText: string,
    public readonly model: string,
    /** The reply was cut off by the output token limit before it finished. */
    public readonly truncated: boolean
  ) {
    super("The model's response contained no JSON plan with a datasetId.");
  }
}

/**
 * No model could be reached at all (no API key, or every model/key in the
 * chain was capped, congested or delisted). Thrown so the pipeline stops
 * with an honest error — no answer is fabricated by a keyword fallback
 * when the question was never actually understood.
 */
export class PlannerUnavailableError extends Error {
  constructor(reason: string) {
    super(`The AI planner is unavailable, so no answer was generated: ${reason}`);
    this.name = "PlanParseError";
  }
}

// Open-source models served via OpenRouter (OpenAI-compatible API), per the
// assignment's "use open-source AI models" constraint. The primary model is
// configurable (OPENROUTER_MODEL) — a fully-free ":free" model sits on a
// shared, congested pool and can be rate-limited or out of capacity at any
// moment. Rather than let that take the planner down to the heuristic
// fallback (accurate but far weaker), each free-tier candidate below is
// tried in order before giving up.
const MODEL = process.env.OPENROUTER_MODEL ?? "qwen/qwen-2.5-7b-instruct";
// Free-tier only (no paid model is ever called). Note that OpenRouter's
// per-day free quota is per ACCOUNT, shared by every ":free" model, so a
// longer chain helps with a congested or delisted model, not with a spent
// daily cap — more API keys do.
const FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nex-agi/nex-n2.5-pro:free",
  "thinkingmachines/inkling:free",
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
const PLANNER_MAX_TOKENS = 2000;
const RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_BACKOFF_MS = 1500;

function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit/i.test(msg);
}

// A per-DAY cap is not congestion: it will not clear in the seconds a retry
// waits, and it will not clear for the rest of this process either. Such a
// (model, key) pair is skipped outright instead of costing a backoff ladder
// on every single call — which is what turned a 5-second plan into a
// 70-second one.
function isDailyCap(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /per.?day|daily|requests per day/i.test(msg);
}
const EXHAUSTED_TTL_MS = 60 * 60 * 1000;
// Ordinary 429s (a congested free provider) clear in a minute or so; a pair
// that just failed that way is skipped for the next requests instead of
// being re-tried with backoff by every question in the meantime.
const CONGESTED_TTL_MS = 90 * 1000;
// Wall-clock budget for one planner call across the whole model/key chain.
// Without it, 4 keys × 4 models × backoff retries turned a single question
// into a five-minute wait that the client gave up on.
const CHAIN_BUDGET_MS = 60 * 1000;
const exhaustedUntil = new Map<string, number>();
const exhaustedKey = (model: string, client: OpenAI) => `${model}|${client.apiKey.slice(-8)}`;

// Ordering matters here: exhaust every API key on the PRIMARY model first
// (each key has its own rate-limit bucket, so a second key is a real way
// past a 429 on the model you actually asked for) before dropping down to
// a different fallback model at all.
async function completeJson(
  clients: OpenAI[],
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<{ text: string; model: string; finishReason?: string }> {
  let lastErr: unknown;
  const deadline = Date.now() + CHAIN_BUDGET_MS;
  for (const model of MODEL_CHAIN) {
    for (const client of clients) {
      if (Date.now() > deadline) throw lastErr ?? new Error("Planner time budget exhausted before any model answered.");
      const k = exhaustedKey(model, client);
      const until = exhaustedUntil.get(k);
      if (until && until > Date.now()) continue;
      try {
        const { text, finishReason } = await completeJsonWithModel(client, model, system, userMessage, maxTokens);
        return { text, model, finishReason };
      } catch (err) {
        lastErr = err;
        if (isDailyCap(err) || isModelUnavailable(err)) exhaustedUntil.set(k, Date.now() + EXHAUSTED_TTL_MS);
        else if (isRateLimited(err) || isCapacityError(err)) exhaustedUntil.set(k, Date.now() + CONGESTED_TTL_MS);
        // Only move on to the next key/model for capacity-related failures
        // (rate limit, out of credits/capacity) — anything else (bad
        // request, auth) will fail identically everywhere, so there's no
        // point burning the whole chain on it.
        if (!isRateLimited(err) && !isCapacityError(err) && !isModelUnavailable(err)) throw err;
        console.error(`completeJson: "${model}" unavailable (${err instanceof Error ? err.message : err}), trying next option.`);
      }
    }
  }
  throw lastErr;
}

// A model id that OpenRouter no longer serves (404 "This model is
// unavailable for free" / "No endpoints found") is specific to that model,
// not to the request, so the chain moves on rather than giving up.
function isModelUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|unavailable|no endpoints|not found/i.test(msg);
}

function isCapacityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /402|insufficient credits|no.*instances|not available/i.test(msg);
}

interface Completion {
  text: string;
  /** "length" means the model was cut off by max_tokens — its JSON may simply never have been reached. */
  finishReason?: string;
}

async function completeJsonWithModel(client: OpenAI, model: string, system: string, userMessage: string, maxTokens: number): Promise<Completion> {
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
      const finishReason = response.choices[0]?.finish_reason ?? undefined;
      const content = response.choices[0]?.message?.content;
      if (content) return { text: content, finishReason };
      // Some reasoning models put the answer in a non-standard "reasoning"
      // field instead of "content" when they run out of budget mid-thought —
      // salvage a trailing JSON object from it rather than treating this as
      // a total failure straight to the heuristic fallback.
      const reasoning = (response.choices[0]?.message as { reasoning?: string } | undefined)?.reasoning;
      return { text: reasoning ?? "", finishReason };
    } catch (err) {
      lastErr = err;
      // A free-tier shared pool returning 429 is transient congestion, not
      // a real failure — worth a couple of short retries before giving up
      // to the much weaker heuristic fallback.
      if (!isRateLimited(err) || isDailyCap(err) || attempt === RATE_LIMIT_RETRIES) throw err;
    }
  }
  throw lastErr;
}

// ─── Query Planner (Figure 4) ──────────────────────────────────────────────

/**
 * Builds the user message for the planner: the (pruned) schema, the
 * relationships, the schema link, any ambiguity notes and the question.
 * Pure, so the exact prompt for any question can be inspected offline.
 */
export function buildPlannerUserMessage(
  question: string,
  datasets: DatasetSchemaContext[],
  relationships: RelationshipRecord[],
  ambiguities: AmbiguityWarning[] = [],
  link?: SchemaLink,
  feedback?: string
): string {
  // Datasets are identified to the model BY NAME, not by their internal
  // random id. Copying "ds_3sgmoki33is" correctly out of a dozen lookalike
  // random strings is a real failure mode — observed the model name the
  // right table in its own "reasoning" while pointing datasetId at a
  // different one. A filename is meaningful, so a slip is both less likely
  // and recoverable by fuzzy-matching downstream.
  // Names and types alone cannot separate an "amount" in one file from an
  // "amount" in another. A couple of real values and a key marker usually
  // can, and they are the cheapest disambiguating evidence available.
  // Schema pruning. A small model's accuracy drops as irrelevant tables are
  // added to its prompt; with six tables and thirteen relationships it kept
  // grouping by a similar-sounding column in the wrong file instead of
  // joining. When linking has identified the datasets the question needs,
  // those are shown in full and the rest are reduced to a one-line
  // "also available" entry — still reachable, no longer competing.
  const focusIds = new Set<string>();
  if (link && link.requiredDatasetIds.length > 0) {
    for (const id of link.requiredDatasetIds) focusIds.add(id);
    for (const j of link.joinPath) focusIds.add(j.datasetId);
    for (const j of link.lookupJoins) focusIds.add(j.datasetId);
    for (const c of link.columns) for (const id of c.datasetIds) focusIds.add(id);
  }
  const inFocus = (id: string) => focusIds.size === 0 || focusIds.has(id);

  const schemaContext = datasets.filter((d) => inFocus(d.id)).map((d) => ({
    dataset: d.name,
    rowCount: d.rowCount,
    prefixWhenJoined: joinPrefix(d.name),
    columns: d.columns.map((c) => ({
      name: c.name,
      type: c.type,
      ...(c.isUnique ? { uniquePerRow: true } : {}),
      ...(c.sample?.length ? { examples: c.sample.slice(0, 3) } : {}),
    })),
  }));
  const otherDatasets = datasets.filter((d) => !inFocus(d.id)).map((d) => `${d.name} (${d.columns.map((c) => c.name).join(", ")})`);
  const relationshipContext = relationships.filter((r) => inFocus(r.datasetIdA) && inFocus(r.datasetIdB)).map((r) => ({
    datasetA: datasets.find((d) => d.id === r.datasetIdA)?.name ?? r.datasetIdA,
    columnA: r.columnA,
    datasetB: datasets.find((d) => d.id === r.datasetIdB)?.name ?? r.datasetIdB,
    columnB: r.columnB,
    basis: r.basis,
    confidence: r.confidence,
    ...(r.cardinality ? { cardinality: r.cardinality } : {}),
  }));

  const ambiguityLine = ambiguities.length
    ? `\n\nHeads up — this question's wording could mean more than one column:\n${ambiguities
        .map((a) => `- "${a.concept}": ${a.candidates.map((c) => `"${c.column}" (${c.datasetName})`).join(" or ")}`)
        .join("\n")}\nPick the one that most literally matches the question, and say which one you picked (and that alternatives exist) in "reasoning".`
    : "";
  // The schema link, stated as facts the model can copy rather than a
  // search it has to run: which file each named column lives in, which
  // datasets are therefore mandatory, and the exact join keys in order.
  const nameOf = (id: string) => datasets.find((d) => d.id === id)?.name ?? id;
  const linkBlock = link && (link.columns.length > 0 || link.requiredDatasetIds.length > 0)
    ? [
        "",
        "",
        "Schema link — worked out from the question and the data, so use it rather than guessing:",
        ...link.columns.map((c) =>
          c.datasetIds.length === 1
            ? `- "${c.term}" → column "${c.column}", which exists ONLY in "${nameOf(c.datasetIds[0])}"`
            : `- "${c.term}" → column "${c.column}", present in ${c.datasetIds.map((id) => `"${nameOf(id)}"`).join(" and ")} (say which in "reasoning")`
        ),
        ...(link.requiredDatasetIds.length > 0
          ? [`Datasets the plan MUST include: ${link.requiredDatasetIds.map((id) => `"${nameOf(id)}"`).join(", ")}.`]
          : []),
        ...(link.suggestedBaseId
          ? [`Suggested base ("datasetId"): "${nameOf(link.suggestedBaseId)}" — it holds the rows being counted or summed.`]
          : []),
        ...(link.joinPath.length > 0
          ? ["Join path from that base, in order:", ...link.joinPath.map((j, i) => `  ${i + 1}. join "${nameOf(j.datasetId)}" with leftOn "${j.leftOn}", rightOn "${j.rightOn}"${j.cardinality ? ` (${j.cardinality})` : ""}`)]
          : []),
        ...(link.lookupJoins.length > 0
          ? ["To show names instead of ids, you may also join:", ...link.lookupJoins.map((j) => `  - "${nameOf(j.datasetId)}" with leftOn "${j.leftOn}", rightOn "${j.rightOn}"`)]
          : []),
        ...(link.unreachable.length > 0
          ? [`No relationship connects ${link.unreachable.map((id) => `"${nameOf(id)}"`).join(", ")} to the base — say so in "reasoning" rather than inventing a join key.`]
          : []),
      ].join("\n")
    : "";
  const othersBlock = otherDatasets.length > 0
    ? `\n\nAlso available (not shown in full because the question doesn't appear to need them; name one exactly if it does): ${otherDatasets.join("; ")}`
    : "";
  const userMessage = `Datasets:\n${JSON.stringify(schemaContext, null, 2)}${othersBlock}\n\nRelationships:\n${JSON.stringify(relationshipContext, null, 2)}${linkBlock}${ambiguityLine}\n\nQuestion: ${question}${feedback ?? ""}`;
  return userMessage;
}

export async function planQuery(
  question: string,
  datasets: DatasetSchemaContext[],
  relationships: RelationshipRecord[],
  ambiguities: AmbiguityWarning[] = [],
  userApiKey?: string,
  trace?: LlmCallTrace,
  /** On a retry: what the last plan got wrong and how to fix it (see answer-check.ts). */
  feedback?: string,
  /** Which columns/datasets the question names and how they join (see schema-linking.ts). */
  link?: SchemaLink
): Promise<QueryPlan> {
  const clients = getClients(userApiKey);
  if (clients.length === 0) {
    throw new PlannerUnavailableError("no API key is configured (neither a server key nor one set in the browser).");
  }

  const system = `You are a query planner for a tabular data analysis tool. Given a user's natural-language question and the schema of one or more datasets (plus detected column relationships between them), output ONLY a JSON object (no markdown, no prose) matching this TypeScript type:

type QueryPlan = {
  datasetId: string;            // the NAME of the base dataset, copied EXACTLY as it appears in the "dataset" field of the list below, including any sheet suffix (e.g. "finance.xlsx — Q1"). Never invent a name, and never use a name that isn't in the list. The base dataset MUST be the one that actually contains the main number the question asks for — if the question asks for a total of some column, the base is the dataset holding that column, not a different dataset that merely relates to it.
  joins?: { datasetId: string; on?: string; leftOn?: string; rightOn?: string; type?: "inner"|"left" }[]; // datasetId here is also the joined dataset's NAME, copied exactly. Use when the question needs data from more than one dataset. Use "on" ONLY when both datasets name the join column identically. If a relationship below has different columnA/columnB names (e.g. matched by value overlap, not name), you MUST use leftOn (the base dataset's column name) + rightOn (the joined dataset's column name) instead — do not invent a column name that doesn't exist in one of the datasets, that silently produces garbage results. A question can need data from a THIRD dataset that has no direct relationship to the base — e.g. base is a readings table with only a sensor id, and the question wants a "site name" that lives in a sites table connected only through a sensors table. In that case list BOTH joins: one from the base to the intermediate dataset, then one from the intermediate dataset's key to the third dataset (leftOn/rightOn can reference a column that only exists after the FIRST join has been applied).
  derive?: { as: string; expr: string }[]; // computed row-level columns, evaluated before filters/groupBy/aggregations. expr is ARITHMETIC ONLY over existing numeric column names: + - * / ( ) and number literals — no functions, no strings. Use this whenever the question needs a value that isn't already a literal column but is a straightforward formula over ones that exist — a total built from a count column times a per-unit column, a net figure built from a gross column minus a deduction column, and so on. Never invent a number outside this expression grammar.
  select?: string[];            // columns to include in the output, omit for all
  filters?: { column: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"; value: string|number|boolean }[];
  dateBucket?: { column: string; granularity: "day"|"month"|"year"; as?: string }; // use for trend/time-series questions to bucket a date column before grouping
  groupBy?: string[];
  aggregations?: { column: string; fn: "sum"|"avg"|"count"|"countDistinct"|"min"|"max"; as?: string }[]; // "count" counts ROWS; "countDistinct" counts unique values of the column and works on text columns too. When a table has several rows per entity (one row per employee per month/cycle), "how many employees" means countDistinct on the id column — plain count would report the row count instead, which is a different and wrong number.
  having?: { column: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"; value: string|number|boolean }[]; // filters applied AFTER grouping, against the aggregate results (SQL HAVING). "column" must be an aggregation's "as" name or a groupBy column — never a raw source column.
  correlate?: { columnX: string; columnY: string }; // set this whenever the question asks about correlation / relationship strength between two numeric columns — this computes an actual Pearson coefficient, which a chart alone cannot do
  sort?: { column: string; direction: "asc"|"desc" }[];
  limit?: number;
  chartType?: "bar"|"stacked-bar"|"dot"|"line"|"area"|"pie"|"scatter"|"histogram"|"radar"|"treemap"|"heatmap"|"none";
  chartX?: string;              // column for x-axis / category, required if chartType != "none"
  chartY?: string[];            // column(s) for y-axis / value, required if chartType != "none"
  reasoning?: string;           // one sentence on why this plan answers the question
};

A question comparing multiple values of the SAME column ("open vs closed", "domestic vs export", "compare X and Y") wants a groupBy on that column, NOT a filter — a plan can only have one value per "eq" filter on a column, so filtering "status = open" AND "status = closed" at once matches zero rows. GroupBy shows every value (including ones not named) in one result; only add a filter when the question wants to see ONE value/subset, not when it's comparing several.

Only reference columns that exist in the given schema. After a join, a joined-in column keeps its original name unless a column of that name already exists, in which case it is renamed to that dataset's "prefixWhenJoined" value + "_" + the column name (the prefix is given per dataset above — use it exactly; it is NOT the file name). So if two files each have "amount" and the second is joined in, the base's stays "amount" and the joined one becomes e.g. "refunds_amount". Pick sensible defaults: totals/averages/counts always need an "aggregations" entry (never leave a "total"/"average" question as an unaggregated row dump); "by <dimension>" or "each <dimension>" implies groupBy; "top/bottom N" implies sort+limit; chartType "none" only for a single scalar answer. Chart choice: bar for comparing a handful of categories, dot instead of bar when there are more than ~12 categories, line for trends over time, area for cumulative/running totals over time, pie for a proportion breakdown of 5 or fewer categories, treemap for a proportion breakdown of 6+ categories, histogram for the distribution of one numeric column, scatter for the relationship between two numeric columns (pair with "correlate"), radar for comparing several metrics across a few entities, heatmap for a value across two categorical dimensions at once.

For a trend/time-series question, you MUST bucket the date column with dateBucket before grouping by it — never groupBy a raw date column directly, since every row has a distinct timestamp and that produces one group per row instead of a real trend. Example: question "show the monthly usage trend", dataset has date column "reading_taken_at" and numeric column "kwh":
{"datasetId":"meter_readings.csv","dateBucket":{"column":"reading_taken_at","granularity":"month","as":"reading_month"},"groupBy":["reading_month"],"aggregations":[{"column":"kwh","fn":"sum","as":"total_kwh"}],"sort":[{"column":"reading_month","direction":"asc"}],"chartType":"line","chartX":"reading_month","chartY":["total_kwh"]}

"Top/bottom N" questions come in two different shapes — do not confuse them:
1. "Top N <rows> by <column>" (the rows themselves are already what's being ranked, e.g. "top 10 books by page count") needs ONLY select+sort+limit — no "aggregations" and no "groupBy" at all, since there is nothing to summarize, just rows to rank and truncate: {"datasetId":"library.csv","select":["title","page_count"],"sort":[{"column":"page_count","direction":"desc"}],"limit":10,"chartType":"bar","chartX":"title","chartY":["page_count"]}
2. "Top N <categories> by <measure>" (ranking groups by a computed summary, e.g. "top 10 genres by total pages") needs groupBy+aggregations+sort+limit together. Adding "aggregations" without "groupBy" collapses ALL rows into a single summary row — never do that for a per-row ranking question, it silently turns a 10-row answer into 1.

When the question names a quantity that is NOT a literal column but is a plain formula over columns that do exist, derive it first instead of aggregating a column that isn't there. Percentage columns hold whole numbers (a value of 10 means 10%), so convert them with /100 and combine as (1 + pct/100) to add or (1 - pct/100) to deduct. Example: a table with units_used, rate_per_unit and tax_pct but no "billed" column, asked for total billed:
{"datasetId":"usage.csv","derive":[{"as":"billed","expr":"units_used * rate_per_unit * (1 + tax_pct / 100)"}],"aggregations":[{"column":"billed","fn":"sum","as":"total_billed"}]}
The same applies to any such quantity — work out which existing numeric columns combine into it, and write that arithmetic in "derive".

A question about entities that meet a condition ACROSS several of their rows — "in both terms", "in every semester", "in all three seasons" — is a groupBy + aggregation + "having", never a plain row filter. A row-level filter can only ask "does this ONE row meet the threshold"; counting those rows answers a completely different question (it counts rows, not entities, and includes entities that qualified in only one period). The shape is: filter the rows to the ones meeting the threshold, group by the entity, countDistinct the period column to see how many periods each entity survived in, then require that count to be the number of periods the question demands. Example: a table of branch_code, semester, enrolments, asked "how many branches exceeded 200 in all three semesters":
{"datasetId":"semester_enrolments.csv","filters":[{"column":"enrolments","op":"gt","value":200}],"groupBy":["branch_code"],"aggregations":[{"column":"semester","fn":"countDistinct","as":"qualifying_semesters"}],"having":[{"column":"qualifying_semesters","op":"gte","value":3}],"chartType":"none"}
"both"/"all" means the having threshold is the number of distinct periods in the data (2 for two terms, 3 for three semesters). The result is one row per qualifying entity, and the row count IS the answer to "how many".

For a cross-dataset question, check the Relationships list below first — each entry gives columnA (in datasetIdA) and columnB (in datasetIdB) plus how it was detected ("name" = identical column names; "value-overlap" = the column names differ but their actual values substantially overlap, e.g. a "country" column and a "nation" column both containing the same country names). Only join on a relationship that's actually listed; if no relationship connects the datasets you need, say so in "reasoning" and answer from the single dataset you can, rather than guessing a join key.

Three-dataset example — this pattern applies whenever the value you need to group by lives TWO joins away from the base dataset, regardless of what the datasets are actually called: base "readings" (columns reading_id, temperature, sensor_id) needs to be broken down by "site name", which only exists in "sites" (site_id, site_name) — and readings has no site_id at all, only "sensors" (sensor_id, site_id) connects the two:
{"datasetId":"readings.csv","joins":[{"datasetId":"sensors.csv","on":"sensor_id"},{"datasetId":"sites.csv","on":"site_id"}],"groupBy":["site_name"],"aggregations":[{"column":"temperature","fn":"avg","as":"avg_temperature"}],"chartType":"bar","chartX":"site_name","chartY":["avg_temperature"]}
Do NOT join a dataset that the question doesn't actually need data from, even if a relationship to it exists — an extra join multiplies every row (and every sum) by however many matching rows it adds. Only include a join whose columns you will actually filter/groupBy/aggregate/select/chart by.

Each relationship also carries a "cardinality". "1:N" means datasetA holds each key value once while datasetB repeats it; "N:1" is the reverse; "1:1" means both sides hold it once; "N:M" means neither does. Joining an N:M pair produces every combination of matching rows, which multiplies the data and inflates any total taken over it — only do that if the question genuinely asks about the combinations. When a one-side is joined to a many-side, each of the one-side's rows is duplicated, so a sum/average/count over one of ITS OWN columns afterwards counts the same value repeatedly: pick as "datasetId" the dataset that actually holds the number being aggregated, and join outwards from it.

The same column name can appear in several datasets and mean completely different things — each file may have its own "amount", "date", "name" or "id". A column marked "uniquePerRow" holds each value once, which is what an identifier looks like; one that repeats is usually a measure or a category. Use that, plus the "examples" values and the file's other columns, to decide which dataset a question's wording actually refers to, and name that dataset in "reasoning" when more than one could have been meant.

This system only aggregates and summarizes data that already exists — it has no forecasting, prediction, or trend-extrapolation capability. If asked to predict, forecast, or project a future value, do NOT invent one: plan the closest honest historical answer instead (e.g. the actual past trend), never name an aggregation "predicted_x"/"forecast_x", and use "reasoning" to note that forecasting isn't supported so the explanation reflects that limitation rather than presenting a fabricated number as a real prediction.`;

  const userMessage = buildPlannerUserMessage(question, datasets, relationships, ambiguities, link, feedback);

  if (trace) {
    trace.systemPrompt = system;
    trace.userPrompt = userMessage;
  }

  const started = Date.now();
  try {
    // A plan is a few hundred tokens, but some models reason at length in
    // their visible output before writing it — at a tight budget that
    // reasoning gets cut off before the JSON ever appears, and the retry then
    // has to work from nothing. The budget is sized for the reasoning, not
    // the plan.
    const { text, model, finishReason } = await completeJson(clients, system, userMessage, PLANNER_MAX_TOKENS);
    if (trace) {
      trace.model = model;
      trace.rawResponse = text;
      trace.ms = Date.now() - started;
      trace.finishReason = finishReason;
    }
    const plan = extractJson<QueryPlan>(text);
    if (!plan || !plan.datasetId) throw new PlanParseError(text, model, finishReason === "length");
    return plan;
  } catch (err) {
    if (err instanceof PlanParseError) throw err;
    if (trace) trace.ms = Date.now() - started;
    throw new PlannerUnavailableError(`every model/key in the chain failed (last error: ${err instanceof Error ? err.message : String(err)}). Try again in a minute or add another API key.`);
  }
}

// ─── Selection planner (semantic-layer mode) ──────────────────────────────
//
// The planner picks measures and dimensions from a menu and never writes a
// join; compile-selection.ts turns the pick into an executable plan with the
// joins worked out from the relationship graph. This is the published
// "semantic layer" approach: the decision a small model gets wrong most —
// which file, which key — is removed from it entirely.

export type PlannerOutput =
  | { kind: "selection"; selection: Selection }
  | { kind: "plan"; plan: QueryPlan };

const SELECTION_SYSTEM = `You are a query planner for a tabular data analysis tool. You are given a MENU of measures and dimensions across the uploaded files (each written as alias.column), the relationships between files, and a question. Output ONLY a JSON object (no markdown, no prose) matching this TypeScript type:

type Selection = {
  measures?: { ref: string; fn: "sum"|"avg"|"count"|"countDistinct"|"min"|"max"; as?: string }[]; // what to compute. ref is copied EXACTLY from the menu (alias.column) or is the "as" name of a derive below. "count" counts rows; "countDistinct" counts distinct values and works on any column — "how many members" over a table with one row per loan is countDistinct on the member id.
  dimensions?: string[];        // refs to group by — "by industry" / "per team" / "for each plan". Omit for a single overall figure.
  filters?: { ref: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"in"|"notIn"|"isNull"|"isNotNull"; value?: string|number|boolean|(string|number)[] }[]; // row filters. "in" takes a list — "returned or lost" is ONE filter: { ref, op: "in", value: ["Returned","Lost"] }; use the exact values listed in the menu. isNull matches blank cells (e.g. a return date that is empty = not yet returned).
  derive?: { as: string; expr: string }[]; // a quantity that is not a column but a plain formula over menu refs: "alias.units_used * alias.rate_per_unit", "alias.gross * (1 - alias.deduction_pct / 100)". Arithmetic only. Then aggregate it via measures with ref = its "as".
  dateBucket?: { ref: string; granularity: "day"|"month"|"year"; as?: string }; // for trends over time; the "as" name is grouped by automatically.
  having?: { column: string; op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"; value: string|number }[]; // conditions on measure "as" names AFTER grouping (entities meeting a condition across several rows: "in every period", "in all three semesters").
  without?: string[];           // table ALIASES the rows must have NO match in — "branches with no loans" = select branch fields, without: ["<loans alias>"].
  select?: string[];            // refs to list, for a row listing (no measures). "top N rows by X" = select + sort + limit.
  sort?: { column: string; direction: "asc"|"desc" }[]; // column is a measure "as" name, a dimension column name, or a selected column name. "most/highest/slowest/largest" = desc; "least/lowest/fastest/smallest" = asc.
  limit?: number;
  correlate?: { x: string; y: string }; // two numeric refs, when the question asks about correlation.
  chartType?: "bar"|"stacked-bar"|"dot"|"line"|"area"|"pie"|"scatter"|"histogram"|"radar"|"treemap"|"heatmap"|"none";
  chartX?: string; chartY?: string[]; // output column names
  reasoning?: string;           // one sentence: which refs you chose and why
};

Rules:
- Copy refs from the menu exactly. Never invent a column. If two files both have the column you need, pick the one whose table matches the question and say so in "reasoning".
- You never write joins. Referencing fields from several tables is fine — they are joined automatically.
- A question asking for a total/average/count needs a measure. "by X"/"per X" needs X as a dimension. A ranking of ROWS ("the 10 longest books") is select+sort+limit with no measure; a ranking of GROUPS ("top 5 genres by total pages") is dimension+measure+sort+limit.
- Comparing values of one column ("open vs closed", "domestic vs export") is a dimension, not two filters.
- If the question names a quantity that is not in the menu but is a formula over menu measures (a total built from a count times a rate, a net figure after a percentage deduction, a run-rate), write it in "derive" and aggregate the derived name.
- "Slowest"/"most"/"highest" sort desc; "fastest"/"least"/"lowest" sort asc.
- This tool only summarises data that exists: no forecasting or prediction. If the data cannot answer, say so in "reasoning" and give the closest honest selection.`;

export async function planSelection(
  question: string,
  datasets: DatasetSchemaContext[],
  relationships: RelationshipRecord[],
  model: SemanticModel,
  ambiguities: AmbiguityWarning[] = [],
  userApiKey?: string,
  trace?: LlmCallTrace,
  feedback?: string,
  link?: SchemaLink
): Promise<PlannerOutput> {
  const clients = getClients(userApiKey);
  if (clients.length === 0) {
    throw new PlannerUnavailableError("no API key is configured (neither a server key nor one set in the browser).");
  }

  const nameOf = (id: string) => datasets.find((d) => d.id === id)?.name ?? id;
  const aliasOf = (id: string) => model.tables.find((t) => t.datasetId === id)?.alias ?? id;
  const linkBlock = link && link.columns.length > 0
    ? [
        "",
        "Schema link — worked out from the question and the data:",
        ...link.columns.map((c) =>
          c.datasetIds.length === 1
            ? `- "${c.term}" → ${aliasOf(c.datasetIds[0])}.${c.column} (only in "${nameOf(c.datasetIds[0])}")`
            : `- "${c.term}" → column "${c.column}" exists in ${c.datasetIds.map((id) => aliasOf(id)).join(", ")} — choose by table`
        ),
        ...(link.mentionedDatasetIds.length ? [`Tables the question names: ${link.mentionedDatasetIds.map(aliasOf).join(", ")}`] : []),
      ].join("\n")
    : "";
  const ambiguityLine = ambiguities.length
    ? `\n\nHeads up — this question's wording could mean more than one column:\n${ambiguities.map((a) => `- "${a.concept}": ${a.candidates.map((c) => `"${c.column}" (${c.datasetName})`).join(" or ")}`).join("\n")}\nPick the one that most literally matches the question and say which in "reasoning".`
    : "";
  // Focus: the tables the question links to, plus every table one join
  // away from them — so a second fact table or a lookup for a name stays in
  // full view. With no links at all, everything is shown.
  const focus = new Set<string>();
  if (link && (link.requiredDatasetIds.length > 0 || link.columns.some((c) => c.strength === "strong"))) {
    for (const id of link.requiredDatasetIds) focus.add(id);
    for (const j of link.joinPath) focus.add(j.datasetId);
    for (const j of link.lookupJoins) focus.add(j.datasetId);
    for (const c of link.columns) if (c.strength === "strong") for (const id of c.datasetIds) focus.add(id);
    for (const id of [...focus]) for (const r of relationships) {
      if (r.datasetIdA === id) focus.add(r.datasetIdB);
      if (r.datasetIdB === id) focus.add(r.datasetIdA);
    }
  }
  const shownRels = relationships.filter((r) => focus.size === 0 || (focus.has(r.datasetIdA) && focus.has(r.datasetIdB)));
  const userMessage = `${renderSemanticMenu(model, focus)}\n\nRelationships (joins are automatic; listed so you know which tables connect):\n${shownRels.map((r) => `- ${aliasOf(r.datasetIdA)}.${r.columnA} = ${aliasOf(r.datasetIdB)}.${r.columnB}${r.cardinality ? ` (${r.cardinality})` : ""}`).join("\n")}${linkBlock}${ambiguityLine}\n\nQuestion: ${question}${feedback ?? ""}`;

  if (trace) {
    trace.systemPrompt = SELECTION_SYSTEM;
    trace.userPrompt = userMessage;
  }

  const started = Date.now();
  try {
    const { text, model: answered, finishReason } = await completeJson(clients, SELECTION_SYSTEM, userMessage, PLANNER_MAX_TOKENS);
    if (trace) {
      trace.model = answered;
      trace.rawResponse = text;
      trace.ms = Date.now() - started;
      trace.finishReason = finishReason;
    }
    const parsed = extractJson<Record<string, unknown>>(text);
    if (parsed && looksLikeSelection(parsed)) return { kind: "selection", selection: parsed as Selection };
    // A model that answers in the older plan shape is still answering.
    const asPlan = parsed as { datasetId?: unknown } | null;
    if (asPlan && typeof asPlan.datasetId === "string") return { kind: "plan", plan: asPlan as unknown as QueryPlan };
    throw new PlanParseError(text, answered, finishReason === "length");
  } catch (err) {
    if (err instanceof PlanParseError) throw err;
    if (trace) trace.ms = Date.now() - started;
    throw new PlannerUnavailableError(`every model/key in the chain failed (last error: ${err instanceof Error ? err.message : String(err)}). Try again in a minute or add another API key.`);
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
export function heuristicPlan(question: string, datasets: DatasetSchemaContext[], relationships: RelationshipRecord[]): QueryPlan {
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
        reasoning: `Keyword fallback (the AI planner produced no usable plan) — computed correlation between ${colX.name} and ${colY.name}.`,
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
      reasoning: "Keyword fallback (the AI planner produced no usable plan) — grouped by month to show a trend.",
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
      reasoning: `Keyword fallback (the AI planner produced no usable plan) — ${agg.fn} of ${agg.column ?? "rows"} grouped by ${groupByCol}.`,
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
      reasoning: `Keyword fallback (the AI planner produced no usable plan) — computed ${agg.fn} of ${agg.column ?? "rows"}.`,
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
      reasoning: "Keyword fallback (the AI planner produced no usable plan) — top/bottom-N by the most relevant numeric column.",
    };
  }

  return {
    datasetId: base.id, joins,
    filters: filters.length ? filters : undefined,
    limit: 50,
    chartType: "none",
    reasoning: "Keyword fallback (the AI planner produced no usable plan) — filtered preview of the dataset.",
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
