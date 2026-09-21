import type { ChartDataPoint, DatasetLink, PipelineStep, QueryResult } from "@/lib/types";
import type { DatasetRecord } from "@/lib/session-store";
import { buildRagContext, checkGroundedness } from "@/lib/rag";
import { answerFromContext, LlmCallTrace, PlanParseError } from "@/lib/llm";
import { evaluateChartChoice } from "@/lib/chart-eval";

// A model that answered with prose instead of the JSON shape is asked once
// more; RAG has no plan to repair, so a second miss is the end.
const MAX_ANSWER_ATTEMPTS = 2;

/**
 * The RAG path of POST /api/query. Entirely separate from the deterministic
 * pipeline: nothing here is planned, validated, joined or executed — the
 * relevant slice of the data is retrieved (see rag.ts) and the model
 * answers from it. The result carries the same shape as a deterministic one
 * so the UI renders it the same way, plus `mode: "rag"` and the model's
 * confidence so it can be labelled as unverified.
 */
export async function answerWithRag(
  queryId: string,
  question: string,
  selected: DatasetRecord[],
  links: DatasetLink[],
  apiKey: string | undefined,
  trace: PipelineStep[]
): Promise<QueryResult> {
  const t0 = Date.now();
  const context = buildRagContext(question, selected.map((d) => ({ id: d.id, name: d.name, columns: d.columns, rows: d.rows ?? [], rowCount: d.rowCount, notes: d.notes })), links);
  const matched = [
    ...context.cellMatches.map((m) => `"${m.value}" = ${m.datasetName}.${m.column} (${m.rowsWithValue} rows)`),
    ...context.dateMatches.map((m) => `${m.year ?? ""}${m.month ? "-" + String(m.month).padStart(2, "0") : ""} in ${m.datasetName}.${m.column} (${m.rows} rows)`),
    ...context.matchedColumns.map((m) => `column ${m.datasetName}.${m.column}`),
  ];
  trace.push({
    id: "retrieve",
    label: "Relevant data retrieved and exact facts computed",
    status: context.sampledOnly ? "warn" : "ok",
    summary: context.sampledOnly
      ? `Nothing in the data matched the question's words (${context.queryTerms.join(", ") || "none"}) — schema, whole-file statistics and a head sample of each file were used`
      : `${context.cellMatches.length} value match${context.cellMatches.length === 1 ? "" : "es"}, ${context.subsets.length} computed subset${context.subsets.length === 1 ? "" : "s"}, ${context.retrieved.length} rows shown, ${context.chars.toLocaleString()} chars of context`,
    detail: [
      matched.length ? `Question words matched: ${matched.join("; ")}` : "Question words matched no column name or categorical value.",
      ...context.subsets.map((s) => `${s.datasetName}: ${s.rows} of ${s.total} rows where ${s.filters.join(" AND ")}${s.propagatedFrom.length ? ` (via key link from ${s.propagatedFrom.join(", ")})` : ""}`),
      ...context.coverage.map((c) => `${c.datasetName}: ${c.retrieved} rows shown of ${c.total.toLocaleString()}`),
    ].join("\n"),
    payload: context.text,
    payloadLabel: "Context given to the model (schema, statistics, computed facts, rows)",
    ms: Date.now() - t0,
  });

  let answer;
  let llmTrace: LlmCallTrace = {};
  let feedback = "";
  for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS; attempt++) {
    llmTrace = {};
    try {
      answer = await answerFromContext(question, context.text + feedback, apiKey, llmTrace);
      break;
    } catch (err) {
      if (!(err instanceof PlanParseError) || attempt === MAX_ANSWER_ATTEMPTS) throw err;
      trace.push({
        id: `llm-${attempt}`,
        label: "Model did not answer in the expected shape",
        status: "warn",
        summary: `${err.model} replied without the JSON answer object — asking again`,
        detail: err.rawText || "(empty response)",
        ms: llmTrace.ms,
      });
      feedback = `\n\n─────────────\nYour previous reply was not the JSON object described. Reply with ONLY that JSON object, starting with {.`;
    }
  }
  if (!answer) throw new Error("The model did not produce an answer.");

  trace.push({
    id: "prompt",
    label: "Context and question sent to the LLM",
    status: "ok",
    summary: `${context.text.length.toLocaleString()} characters of context sent to ${llmTrace.model ?? "the model"}`,
    detail: `SYSTEM PROMPT\n${llmTrace.systemPrompt ?? ""}\n\n─────────────\n\nUSER MESSAGE\n${llmTrace.userPrompt ?? ""}`,
  });
  trace.push({
    id: "llm",
    label: "LLM answered from the retrieved context",
    status: answer.confidence === "low" ? "warn" : "ok",
    summary: `${llmTrace.model ?? "model"} answered (${answer.answerType ?? "type unstated"}) with ${answer.confidence ?? "unstated"} confidence${answer.table ? ` and a ${answer.table.rows.length}-row table` : ""}`,
    detail: llmTrace.rawResponse,
    payload: answer,
    payloadLabel: "Parsed answer",
    ms: llmTrace.ms,
  });

  // Faithfulness: every number in the answer should come from the context.
  const grounding = checkGroundedness(answer.answer, (answer.table?.rows ?? []).flat(), context.text);
  const ungroundedShare = grounding.total ? grounding.missing.length / grounding.total : 0;
  if (grounding.missing.length > 0 && ungroundedShare >= 0.5 && answer.confidence !== "low") answer.confidence = "low";
  trace.push({
    id: "verify",
    label: "Answer checked against the context",
    status: grounding.missing.length ? "warn" : "ok",
    summary: grounding.total === 0
      ? "The answer states no figures to check"
      : `${grounding.grounded} of ${grounding.total} figures in the answer appear in the context${grounding.missing.length ? ` — not found: ${grounding.missing.join(", ")}` : ""}`,
    detail: grounding.missing.length
      ? "A figure that appears nowhere in the context was either computed by the model from other figures (possible, but error-prone) or invented. Treat it with caution; Deterministic mode computes such figures exactly."
      : undefined,
  });

  // Table, if the model gave one, in the engine's row shape.
  const columns = answer.table?.columns?.filter((c) => typeof c === "string") ?? [];
  const tableData = answer.table && columns.length
    ? answer.table.rows.slice(0, 25).map((r) => Object.fromEntries(columns.map((c, i) => [c, r?.[i] ?? null])))
    : undefined;

  const chartType = answer.chartType && answer.chartType !== "none" && tableData && answer.chartX && columns.includes(answer.chartX) && (answer.chartY ?? []).some((y) => columns.includes(y))
    ? answer.chartType
    : "none";
  const yKeys = (answer.chartY ?? []).filter((y) => columns.includes(y));
  const chartData: ChartDataPoint[] | undefined = chartType !== "none" && tableData
    ? tableData.map((row) => {
        const point: ChartDataPoint = { label: String(row[answer.chartX!] ?? ""), value: Number(row[yKeys[0]] ?? 0) };
        for (const y of yKeys) point[y] = Number(row[y] ?? 0);
        return point;
      })
    : undefined;

  const allColumns = selected.flatMap((d) => d.columns);
  const chartEval = evaluateChartChoice(question, chartType, {
    categoryCount: tableData?.length ?? 0,
    hasDateColumn: allColumns.some((c) => c.type === "date"),
    numericColumnCount: allColumns.filter((c) => c.type === "number").length,
    groupByDimensionCount: chartType !== "none" ? 1 : 0,
  });

  const caveat = context.sampledOnly
    ? "This answer was written by the model from each file's column statistics and a small sample of rows — nothing in the data matched the question's words, so it was not computed over the data and should be checked."
    : `This answer was written by the model from retrieved rows, whole-file statistics${context.subsets.length ? " and exact facts computed for the matching rows" : ""} — the wording and any arithmetic are the model's own. Switch to Deterministic mode for a fully computed answer.`;
  const groundingNote = grounding.missing.length
    ? ` Figures not found in the retrieved data (${grounding.missing.join(", ")}) may have been computed by the model — check them.`
    : "";

  return {
    id: queryId,
    question,
    timestamp: new Date(),
    status: "success",
    mode: "rag",
    confidence: answer.confidence,
    tableData,
    columns: tableData ? columns : undefined,
    chartType,
    chartData,
    chartConfig: chartData ? { xKey: "label", yKeys, title: question } : undefined,
    explanation: [
      ...selected.flatMap((d) => (d.notes ?? []).map((n) => `Note (${d.name}): ${n}`)),
      answer.answer,
      `Important: ${caveat}${groundingNote}`,
    ].join(" "),
    followUpSuggestions: answer.followUpSuggestions ?? [],
    chartEval,
    source: {
      files: selected.map((d) => d.name),
      joins: [],
      derived: [],
      filters: [
        ...context.subsets.map((s) => `${s.datasetName}: ${s.filters.join(" AND ")}`),
        `retrieval terms: ${context.queryTerms.join(", ") || "(none)"}`,
      ],
      groupBy: [],
      aggregations: context.subsets.flatMap((s) => s.numeric.map((n) => `${s.datasetName}.${n.column}: sum ${n.sum.toLocaleString("en-US", { maximumFractionDigits: 2 })} over ${n.n} matching rows`)),
      rowsConsidered: context.subsets.length ? context.subsets.reduce((a, s) => a + s.rows, 0) : context.retrieved.length,
      rowsReturned: tableData?.length ?? 0,
    },
    trace,
  };
}
