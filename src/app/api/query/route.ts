import { NextRequest, NextResponse } from "next/server";
import { QueryRequest, QueryResult, ChartDataPoint } from "@/lib/types";
import { getSession, ensureDatasetRows } from "@/lib/session-store";
import { planQuery, explainResults } from "@/lib/llm";
import { executeQueryPlan, joinRows, JoinKeyMissingError } from "@/lib/query-engine";
import { evaluateChartChoice } from "@/lib/chart-eval";
import { validateAndRepairPlan, injectMissingValueFilters, correctHallucinatedDateFilterYear, normalizeMonthNameFilters, dropUnsatisfiableRangeFilters, PlanRepair } from "@/lib/plan-validator";
import { detectUnsupportedConcepts, stripMisleadingAliases } from "@/lib/concept-guard";
import { detectColumnAmbiguity } from "@/lib/data-dictionary";

export const runtime = "nodejs";

// Repairs that changed WHICH data the user is looking at deserve a line in
// the explanation; purely cosmetic ones (a corrected column spelling) don't.
function materialRepairNotes(repairs: PlanRepair[]): string[] {
  return repairs
    .filter((r) => /Dropped|no detected relationship|grouped by|Removed chart/i.test(r.detail))
    .map((r) => `Note: ${r.detail}`);
}

/**
 * POST /api/query
 *
 * Orchestrates Figures 4 + 5: asks the LLM Query Planner for a structured
 * plan scoped to the session's datasets, executes it deterministically, then
 * asks the LLM for a plain-English explanation of the result.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as QueryRequest;
  const { sessionId, question, datasetIds } = body;

  if (!sessionId || !question || !datasetIds?.length) {
    return NextResponse.json({ error: "sessionId, question, and datasetIds are required" }, { status: 400 });
  }

  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found or expired" }, { status: 404 });
  }

  const selected = datasetIds
    .map((id) => session.datasets.get(id))
    .filter((d): d is NonNullable<typeof d> => !!d);

  if (selected.length === 0) {
    return NextResponse.json({ error: "None of the selected datasets exist in this session" }, { status: 400 });
  }

  const queryId = "r_" + Math.random().toString(36).substring(2);

  try {
    const preAmbiguity = detectColumnAmbiguity(question, selected);
    const rawPlan = await planQuery(
      question,
      selected.map((d) => ({ id: d.id, name: d.name, rowCount: d.rowCount, columns: d.columns })),
      session.relationships,
      preAmbiguity
    );

    // A small open-weight planner slips in predictable ways (join key that
    // only exists on one side, dropped groupBy, chart pointed at a column
    // the plan won't produce). Repair those deterministically from the
    // schema before executing, so the answer doesn't depend on how the
    // model happened to sample this time.
    const { plan, repairs } = validateAndRepairPlan(
      rawPlan,
      question,
      selected.map((d) => ({ id: d.id, name: d.name, columns: d.columns })),
      session.relationships
    );

    const target = selected.find((d) => d.id === plan.datasetId) ?? selected[0];
    const byId = new Map(selected.map((d) => [d.id, d]));

    const joinWarnings: string[] = [];
    let workingRows = await ensureDatasetRows(target);
    for (const join of plan.joins ?? []) {
      const joinDataset = byId.get(join.datasetId);
      if (!joinDataset || joinDataset.id === target.id) continue;

      const leftKey = join.leftOn ?? join.on;
      const rightKey = join.rightOn ?? join.on;
      if (!leftKey || !rightKey) {
        joinWarnings.push(`Skipped joining "${joinDataset.name}" — no join column was specified.`);
        continue;
      }

      const joinRowsData = await ensureDatasetRows(joinDataset);
      try {
        workingRows = joinRows(workingRows, joinRowsData, joinDataset.name, leftKey, rightKey, join.type ?? "inner");
      } catch (err) {
        if (err instanceof JoinKeyMissingError) {
          joinWarnings.push(
            `Could not join "${joinDataset.name}" (${err.message}) — results below only reflect "${target.name}".`
          );
          continue;
        }
        throw err;
      }
    }

    // Second validation pass, now that real values are available: catch a
    // filter the question asked for that the plan dropped (schema alone
    // can't see this — the filter value lives in the data).
    const withFilters = injectMissingValueFilters(plan, question, workingRows);
    Object.assign(plan, withFilters.plan);
    repairs.push(...withFilters.repairs);

    const withDateYears = correctHallucinatedDateFilterYear(plan, workingRows);
    Object.assign(plan, withDateYears.plan);
    repairs.push(...withDateYears.repairs);

    const withMonthNames = normalizeMonthNameFilters(plan, workingRows);
    Object.assign(plan, withMonthNames.plan);
    repairs.push(...withMonthNames.repairs);

    const withRangeFilters = dropUnsatisfiableRangeFilters(plan, workingRows);
    Object.assign(plan, withRangeFilters.plan);
    repairs.push(...withRangeFilters.repairs);

    // Refuse to answer a question about a concept these files don't contain
    // (profit with no cost column, churn with no churn column, a forecast).
    // Without this, the planner happily sums revenue, labels it "profit",
    // and the explanation reports it as profit.
    const availableSchema = [
      ...target.columns,
      ...(plan.joins ?? []).flatMap((j) => byId.get(j.datasetId)?.columns ?? []),
    ];
    const conceptWarnings = detectUnsupportedConcepts(question, availableSchema);
    if (conceptWarnings.length > 0) {
      const { aggregations, renames } = stripMisleadingAliases(plan.aggregations, conceptWarnings);
      if (renames.length > 0) {
        plan.aggregations = aggregations as typeof plan.aggregations;
        repairs.push(...renames.map((detail) => ({ field: "aggregations", detail })));
      }
    }

    // A generic term in the question ("salary") can genuinely mean more than
    // one DIFFERENT column across the files in scope. The plan can only ever
    // pick one — surface which one, so the user isn't silently given an
    // answer to a question they didn't quite ask.
    const usedColumnNames = new Set([
      ...(plan.aggregations ?? []).map((a) => a.column),
      ...(plan.groupBy ?? []),
      ...(plan.select ?? []),
      ...(plan.derive ?? []).flatMap((d) => d.expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []),
    ]);
    const ambiguityNotes = preAmbiguity.flatMap((w) => {
      const used = w.candidates.find((c) => usedColumnNames.has(c.column));
      if (!used) return [];
      const others = w.candidates.filter((c) => c.column !== used.column);
      if (others.length === 0) return [];
      return [`"${w.concept}" could mean ${w.candidates.map((c) => `"${c.column}" (${c.datasetName})`).join(" or ")} — this answer uses "${used.column}".`];
    });

    // The planner is instructed to pair chartType "scatter" with a
    // "correlate" entry, but a small model doesn't always remember to set
    // both together — if it asked for a scatter of two columns without also
    // asking for the coefficient, compute it anyway so a "is there a
    // correlation" question never silently comes back with just a plot and
    // no actual number.
    if (plan.chartType === "scatter" && plan.chartX && plan.chartY?.[0] && !plan.correlate) {
      plan.correlate = { columnX: plan.chartX, columnY: plan.chartY[0] };
    }
    // Same gap in the other direction: a correlation was requested but no
    // scatter chart was paired with it — a "is there a correlation"
    // question shouldn't come back as a bare number with nothing to look at.
    if (plan.correlate && (!plan.chartType || plan.chartType === "none")) {
      plan.chartType = "scatter";
      plan.chartX = plan.correlate.columnX;
      plan.chartY = [plan.correlate.columnY];
    }

    const execution = executeQueryPlan(workingRows, plan);

    const joinsUsed: string[] = [];
    const filesUsed = [target.name];
    for (const join of plan.joins ?? []) {
      const joinDataset = byId.get(join.datasetId);
      if (!joinDataset || joinDataset.id === target.id) continue;
      const leftKey = join.leftOn ?? join.on;
      const rightKey = join.rightOn ?? join.on;
      if (!leftKey || !rightKey) continue;
      // Only report joins that actually succeeded (didn't hit a warning above).
      const failed = joinWarnings.some((w) => w.includes(`"${joinDataset.name}"`));
      if (failed) continue;
      filesUsed.push(joinDataset.name);
      joinsUsed.push(`${target.name}.${leftKey} ⋈ ${joinDataset.name}.${rightKey}`);
    }

    const source = {
      files: filesUsed,
      joins: joinsUsed,
      derived: (plan.derive ?? []).map((d) => `${d.as} = ${d.expr}`),
      filters: (plan.filters ?? []).map((f) => `${f.column} ${f.op} ${f.value}`),
      groupBy: [
        ...(plan.groupBy ?? []),
        ...(plan.dateBucket ? [`${plan.dateBucket.column} (by ${plan.dateBucket.granularity})`] : []),
      ],
      aggregations: (plan.aggregations ?? []).map((a) => `${a.fn}(${a.column})${a.as ? ` as ${a.as}` : ""}`),
      sort: plan.sort?.[0] ? `${plan.sort[0].column} ${plan.sort[0].direction}` : undefined,
      limit: plan.limit,
      rowsConsidered: workingRows.length,
      rowsReturned: execution.rows.length,
    };

    const { explanation, followUpSuggestions } = await explainResults(
      question,
      execution.rows,
      execution.columns,
      execution.correlation,
      conceptWarnings.map((w) => w.message)
    );

    const chartData: ChartDataPoint[] | undefined =
      plan.chartType && plan.chartType !== "none" && plan.chartX
        ? execution.rows.map((row) => {
            const point: ChartDataPoint = { label: String(row[plan.chartX!] ?? ""), value: Number(row[(plan.chartY ?? [])[0]] ?? 0) };
            for (const y of plan.chartY ?? []) point[y] = Number(row[y] ?? 0);
            return point;
          })
        : undefined;

    const finalChartType = chartData ? plan.chartType! : "none";
    const allColumns = selected.flatMap((d) => d.columns);
    const chartEval = evaluateChartChoice(question, finalChartType, {
      categoryCount: execution.rows.length,
      hasDateColumn: allColumns.some((c) => c.type === "date"),
      numericColumnCount: allColumns.filter((c) => c.type === "number").length,
      groupByDimensionCount: plan.groupBy?.length ?? 0,
    });

    const result: QueryResult = {
      id: queryId,
      question,
      timestamp: new Date(),
      status: "success",
      tableData: execution.rows,
      columns: execution.columns,
      chartType: finalChartType,
      chartData,
      chartConfig: chartData
        ? { xKey: "label", yKeys: plan.chartY ?? ["value"], title: plan.reasoning }
        : undefined,
      explanation: [
        // Stated by us, not left to the model: if the data can't answer the
        // question, that must appear even if the model ignores the prompt.
        ...conceptWarnings.map((w) => `Important: ${w.message}.`),
        ...ambiguityNotes.map((n) => `Note: ${n}`),
        explanation,
        ...joinWarnings,
        ...execution.warnings,
        ...materialRepairNotes(repairs),
      ]
        .filter(Boolean)
        .join(" "),
      followUpSuggestions,
      planRepairs: repairs.map((r) => `${r.field}: ${r.detail}`),
      chartEval,
      correlation: execution.correlation,
      source,
    };

    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const result: QueryResult = {
      id: queryId,
      question,
      timestamp: new Date(),
      status: "error",
      errorMessage: message,
    };
    return NextResponse.json({ result }, { status: 200 });
  }
}
