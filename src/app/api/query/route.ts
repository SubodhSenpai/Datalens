import { NextRequest, NextResponse } from "next/server";
import { QueryRequest, QueryResult, QueryPlan, ChartDataPoint, DatasetLink, PipelineStep } from "@/lib/types";
import { getSession, ensureDatasetRows } from "@/lib/session-store";
import { planSelection, explainResults, PlanParseError, LlmCallTrace } from "@/lib/llm";
import { buildSemanticModel } from "@/lib/semantic-model";
import { compileSelection, Selection, selectionSignature } from "@/lib/compile-selection";
import { mergeAggregatedResults } from "@/lib/merge-results";
import { planToPandas } from "@/lib/pandas-codegen";
import { executeQueryPlan, joinRows, JoinKeyMissingError, JoinStats, computePearsonCorrelation, interpretCorrelation } from "@/lib/query-engine";
import { evaluateChartChoice } from "@/lib/chart-eval";
import { validateAndRepairPlan, injectMissingValueFilters, correctHallucinatedDateFilterYear, resolveTimeFilters, dropUnsatisfiableRangeFilters, referencedColumns, PlanRepair } from "@/lib/plan-validator";
import { detectUnsupportedConcepts, stripMisleadingAliases, detectPlannerHedging, plannerSaysUnanswerable } from "@/lib/concept-guard";
import { detectColumnAmbiguity } from "@/lib/data-dictionary";
import { findUnselectedMentioned } from "@/lib/scope";
import { assessPlan, retryFeedback, PlanAssessment } from "@/lib/answer-check";
import { linkSchema } from "@/lib/schema-linking";
import { answerWithRag } from "./rag";

export const runtime = "nodejs";

// Planner calls per question, including the first. Each retry is a real
// LLM call, so this is a hard ceiling rather than a target.
const MAX_PLAN_ATTEMPTS = 3;

// Cross-file questions get a second, independent draft; the two are
// compared on what they compute. Agreement is taken as confirmation;
// disagreement is settled by a reconciling call that sees both drafts.
// This trades one extra call on multi-table questions for most of the
// run-to-run variance of a small model. PLAN_CONSENSUS=off disables it.
const PLAN_CONSENSUS = process.env.PLAN_CONSENSUS !== "off";
const SECOND_OPINION = [
  "",
  "─────────────",
  "This is an independent second reading of the same question. Read it afresh — in particular check WHICH table each quantity lives in, whether a named term is a value of a column (then filter that column), whether a data-quality flag should restrict the rows, and whether the question needs every row or only one end of a ranking.",
].join("\n");
const reconcilePrompt = (a: Selection, b: Selection) => [
  "",
  "─────────────",
  "Two independent drafts of the selection for this question disagree. Draft A:",
  JSON.stringify(a),
  "Draft B:",
  JSON.stringify(b),
  "Decide which draft reads the question correctly (or combine the correct parts of both) and output that final selection only. Prefer the draft whose measure comes from the table that actually holds the quantity asked about, whose filters use values listed in the menu, and that respects any data-quality flag.",
].join("\n");

// "Delete the …", "update every …": an instruction to modify data rather
// than a question about it. Only a leading verb counts — "how many were
// removed" is a question.
const MUTATION_VERB = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:delete|remove|drop|erase|purge|truncate|update|modify|change|overwrite|insert|rename|set)\b/i;
function isMutationRequest(question: string): boolean {
  return MUTATION_VERB.test(question);
}

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
  const { sessionId, question, datasetIds, apiKey, mode } = body;

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

  // Every stage appends here so the UI can show what actually ran, in order,
  // instead of only the final numbers.
  const trace: PipelineStep[] = [];

  try {
    // ── RAG mode: retrieve, then let the model answer. Nothing below this
    // branch runs for it; the deterministic pipeline is unchanged. ──────
    if (mode === "rag" && process.env.NEXT_PUBLIC_ENABLE_RAG === "1") {
      trace.push({
        id: "input",
        label: "Question received (RAG mode)",
        status: "ok",
        summary: `"${question}" against ${selected.length} dataset${selected.length === 1 ? "" : "s"} — answered from retrieved context, not computed`,
        detail: selected.map((d) => `${d.name} — ${d.rowCount.toLocaleString()} rows, ${d.columns.length} columns`).join("; "),
      });
      for (const d of selected) await ensureDatasetRows(d);
      const links: DatasetLink[] = session.relationships.map((r) => ({ datasetIdA: r.datasetIdA, datasetIdB: r.datasetIdB, columnA: r.columnA, columnB: r.columnB, cardinality: r.cardinality }));
      const result = await answerWithRag(queryId, question, selected, links, apiKey, trace);
      return NextResponse.json({ result });
    }

    const preAmbiguity = detectColumnAmbiguity(question, selected, session.relationships);

    // A question that names a file the user left unticked (see scope.ts).
    const unselectedMentioned = findUnselectedMentioned(question, Array.from(session.datasets.values()), selected.map((d) => d.id));
    const scopeWarnings = unselectedMentioned.length > 0
      ? [`The question mentions ${unselectedMentioned.map((n) => `"${n}"`).join(" and ")}, which is uploaded but not selected for this query — the answer below was produced without it. Tick it in the file picker and ask again.`]
      : [];
    // A request to change data. Nothing here can write to a file, so say so
    // plainly and answer the reading of the question that CAN be served
    // (the rows it describes) rather than pretending something was changed.
    if (isMutationRequest(question)) {
      scopeWarnings.push("DataLens is read-only: it cannot delete, update or add records, and nothing in your files was changed. The rows that match the description are shown instead.");
    }

    trace.push({
      id: "input",
      label: "Question received",
      status: "ok",
      summary: `"${question}" against ${selected.length} dataset${selected.length === 1 ? "" : "s"}`,
      detail: selected.map((d) => `${d.name} — ${d.rowCount.toLocaleString()} rows, ${d.columns.length} columns${d.notes?.length ? `\n  ↳ ${d.notes.join("\n  ↳ ")}` : ""}`).join("\n"),
      payload: {
        datasets: selected.map((d) => ({ name: d.name, rowCount: d.rowCount, columns: d.columns.map((c) => `${c.name}: ${c.type}`) })),
        detectedRelationships: session.relationships.map((r) => `${r.columnA} ↔ ${r.columnB} (by ${r.basis}, confidence ${r.confidence})`),
        ambiguousTerms: preAmbiguity.map((a) => `${a.concept}: ${a.candidates.map((c) => c.column).join(" | ")}`),
      },
    });

    // ── Plan → validate → check it can answer the question, up to 3 times ──
    // A small model sometimes returns a plan that is valid but answers the
    // wrong SHAPE of question — rows where a total was asked for, or a
    // formula the question spelled out left uncomputed. Those mismatches are
    // detectable without a model (answer-check.ts), so the planner is called
    // again with exactly what was wrong and how to fix it, and the corrected
    // plan is used. Hard cap of MAX_PLAN_ATTEMPTS calls.
    //
    // If no attempt passes, the FIRST plan is kept, not the last: a retry
    // was steered by our feedback, and if the check was mistaken the
    // model's own uninfluenced reasoning is the safer thing to trust.
    const schemaDatasets = selected.map((d) => ({ id: d.id, name: d.name, columns: d.columns }));
    const availableColumnNames = Array.from(new Set(selected.flatMap((d) => d.columns.map((c) => c.name))));

    let plan!: QueryPlan;
    let repairs: PlanRepair[] = [];
    let rawPlan!: QueryPlan;
    let planTrace: LlmCallTrace = {};
    let assessment: PlanAssessment = { ok: true, problems: [], hints: [] };
    let firstAttempt: { plan: QueryPlan; repairs: PlanRepair[]; assessment: PlanAssessment } | undefined;
    let feedback: string | undefined;
    let attempts = 0;

    const plannerDatasets = selected.map((d) => ({ id: d.id, name: d.name, rowCount: d.rowCount, columns: d.columns }));

    // Before asking the model anything: which columns does the question
    // name, which file holds each, and how do those files join? Computed
    // from the question, the column names and the detected relationships.
    // Handed to the planner as facts, and used afterwards to check the plan
    // actually reaches every column the question referred to.
    const link = linkSchema(question, plannerDatasets, session.relationships);
    const nameOf = (id: string) => selected.find((d) => d.id === id)?.name ?? id;
    trace.push({
      id: "schema-link",
      label: "Question linked to columns and files",
      status: link.unreachable.length > 0 ? "warn" : link.columns.length > 0 ? "ok" : "skipped",
      summary: link.columns.length > 0
        ? `${link.columns.length} column${link.columns.length === 1 ? "" : "s"} named → ${link.requiredDatasetIds.length} required dataset${link.requiredDatasetIds.length === 1 ? "" : "s"}${link.joinPath.length ? `, ${link.joinPath.length} join${link.joinPath.length === 1 ? "" : "s"} needed` : ""}`
        : "No column names recognised in the question — the planner sees the full schema",
      detail: [
        ...link.columns.map((c) => `"${c.term}" → ${c.column} in ${c.datasetIds.map(nameOf).join(" | ")}${c.datasetIds.length > 1 ? " (ambiguous)" : ""}`),
        ...(link.suggestedBaseId ? [`Suggested base: ${nameOf(link.suggestedBaseId)}`] : []),
        ...link.joinPath.map((j, i) => `Join ${i + 1}: ${nameOf(j.datasetId)} on ${j.leftOn} = ${j.rightOn}${j.cardinality ? ` (${j.cardinality})` : ""}`),
        ...link.lookupJoins.map((j) => `Optional lookup: ${nameOf(j.datasetId)} on ${j.leftOn} = ${j.rightOn}`),
        ...link.unreachable.map((id) => `UNREACHABLE: ${nameOf(id)} — no relationship connects it`),
      ].join("\n") || undefined,
    });

    // The semantic layer: measures, dimensions and the join graph, inferred
    // from the column profiles and detected relationships. The planner picks
    // from this menu and never writes a join — compile-selection.ts derives
    // the base table and the join chain from what was picked.
    const semanticModel = buildSemanticModel(plannerDatasets, session.relationships);
    const aliasOf = (id: string) => semanticModel.tables.find((t) => t.datasetId === id)?.alias ?? id;
    trace.push({
      id: "semantic-model",
      label: "Semantic menu built (measures, dimensions, join graph)",
      status: "ok",
      summary: `${semanticModel.measures.length} measures, ${semanticModel.dimensions.length} dimensions across ${semanticModel.tables.length} tables, ${semanticModel.relationships.length} relationships`,
      detail: semanticModel.tables.map((t) => `${t.alias} = ${t.name} (${t.rowCount.toLocaleString()} rows; keys: ${t.keyColumns.join(", ") || "none"})`).join("\n"),
    });

    let rawSelection: Selection | undefined;
    let compileWarnings: string[] = [];
    let compileExcluded: string[] = [];
    // Extra sub-plans of a multi-fact selection (measures from several
    // tables): each is aggregated on its own and merged with the first
    // plan's result on the dimensions, so no fact table is joined to another.
    let extraPlans: QueryPlan[] = [];
    let mergeDimensionCount = 0;
    for (attempts = 1; attempts <= MAX_PLAN_ATTEMPTS; attempts++) {
      planTrace = {};
      rawSelection = undefined;
      compileWarnings = [];
      compileExcluded = [];
      extraPlans = [];
      mergeDimensionCount = 0;
      const attemptTag = attempts === 1 ? "" : ` (attempt ${attempts})`;
      try {
        let out = await planSelection(question, plannerDatasets, session.relationships, semanticModel, preAmbiguity, apiKey, planTrace, feedback, link);
        // Consensus: a second independent draft on the first attempt of a
        // cross-file question; reconcile when the two compute different things.
        if (out.kind === "selection" && attempts === 1 && PLAN_CONSENSUS && selected.length >= 2) {
          const secondTrace: LlmCallTrace = {};
          try {
            const second = await planSelection(question, plannerDatasets, session.relationships, semanticModel, preAmbiguity, apiKey, secondTrace, SECOND_OPINION, link);
            if (second.kind === "selection") {
              const agree = selectionSignature(second.selection) === selectionSignature(out.selection);
              if (agree) {
                trace.push({ id: "consensus", label: "Second independent draft agrees", status: "ok", summary: `${secondTrace.model ?? "the model"} produced the same computation independently — accepted with confidence`, ms: secondTrace.ms });
              } else {
                const reconcileTrace: LlmCallTrace = {};
                const final = await planSelection(question, plannerDatasets, session.relationships, semanticModel, preAmbiguity, apiKey, reconcileTrace, reconcilePrompt(out.selection, second.selection), link);
                trace.push({
                  id: "consensus",
                  label: "Second draft differed — reconciled",
                  status: "warn",
                  summary: `Two drafts computed different things; ${reconcileTrace.model ?? "the model"} reconciled them${final.kind === "selection" ? "" : " (reconciliation failed; first draft kept)"}`,
                  detail: `Draft A: ${JSON.stringify(out.selection)}\nDraft B: ${JSON.stringify(second.selection)}`,
                  payload: final.kind === "selection" ? final.selection : undefined,
                  payloadLabel: "Reconciled selection",
                  ms: (secondTrace.ms ?? 0) + (reconcileTrace.ms ?? 0),
                });
                if (final.kind === "selection") { out = final; planTrace.rawResponse = reconcileTrace.rawResponse ?? planTrace.rawResponse; planTrace.model = reconcileTrace.model ?? planTrace.model; }
              }
            }
          } catch (err) {
            // A failed second opinion never costs the answer: the first draft stands.
            trace.push({ id: "consensus", label: "Second draft unavailable", status: "skipped", summary: `Could not obtain a second draft (${err instanceof Error ? err.message.slice(0, 120) : "error"}); the first draft stands.` });
          }
        }
        if (out.kind === "selection") {
          rawSelection = out.selection;
          const compiled = compileSelection(out.selection, semanticModel);
          rawPlan = compiled.plan;
          compileWarnings = compiled.notes.filter((n) => /^Dropped|No relationship/.test(n));
          compileExcluded = compiled.excludedDatasetIds;
          extraPlans = compiled.plans.slice(1);
          mergeDimensionCount = compiled.mergeDimensionCount;
          trace.push({
            id: attempts === 1 ? "compile" : `compile-${attempts}`,
            label: `Selection compiled to a plan${attemptTag}`,
            status: compiled.notes.some((n) => /dropped|No relationship/i.test(n)) ? "warn" : "ok",
            summary: `${(out.selection.measures ?? []).length} measure(s), ${(out.selection.dimensions ?? []).length} dimension(s), ${(out.selection.filters ?? []).length} filter(s) → base + ${(compiled.plan.joins ?? []).length} join(s), decided by the compiler`,
            detail: compiled.notes.join("\n"),
            payload: out.selection,
            payloadLabel: "Selection returned by the model (menu refs — no joins)",
          });
        } else {
          rawPlan = out.plan;
        }
      } catch (err) {
        if (!(err instanceof PlanParseError)) throw err;
        // The model replied with something that isn't a plan (prose, a
        // question back, truncated JSON). That is exactly the kind of slip a
        // second call fixes when the model is shown what it sent — so it is
        // retried like any other failed attempt, and the keyword planner is
        // the last resort, not the first reflex.
        trace.push({
          id: attempts === 1 ? "llm" : `llm-${attempts}`,
          label: `LLM did not return a plan${attemptTag}`,
          status: "warn",
          summary: err.truncated
            ? `${err.model} was cut off by the output limit before writing the plan${attempts < MAX_PLAN_ATTEMPTS ? " — asking it to continue" : ""}`
            : `${err.model} replied, but the reply contained no JSON plan${attempts < MAX_PLAN_ATTEMPTS ? " — asking again" : ""}`,
          detail: err.rawText || "(empty response)",
          ms: planTrace.ms,
        });
        if (attempts < MAX_PLAN_ATTEMPTS) {
          // A reply that is reasoning, not a plan, is worth keeping: a model
          // that thought its way to the right formula and ran out of room
          // should be asked to finish that thought, not told to stop thinking
          // and answer in one line — that is how a good derivation turns into
          // a shallow average of the wrong column.
          const raw = err.rawText || "";
          const looksLikeReasoning = raw.length > 200 && !/^\s*\{/.test(raw);
          feedback = looksLikeReasoning
            ? [
                "",
                "─────────────",
                "Your previous reply was reasoning that stopped before the plan was written" + (err.truncated ? " (it ran out of room)" : "") + ". It was:",
                raw.slice(-1500),
                "",
                "Continue from that reasoning and output the plan it leads to — as the JSON object described above, nothing else. It must start with { and include \"datasetId\". If your reasoning found that a quantity has to be computed from existing columns, express it with \"derive\".",
              ].join("\n")
            : [
                "",
                "─────────────",
                "Your previous reply was not a plan. It began:",
                (raw || "(empty)").slice(0, 400),
                "",
                "Reply with ONLY the JSON object described above — no prose, no markdown fences, no questions back. It must start with { and include \"datasetId\".",
              ].join("\n");
          continue;
        }
        // The model answered every time but never with a plan. Stop here
        // rather than answer from keyword matching — a result that does not
        // come from understanding the question is worse than no result.
        throw new Error(`The AI model (${err.model}) replied ${MAX_PLAN_ATTEMPTS} times without producing a usable plan, so no answer was generated. Try rephrasing the question, or ask again in a minute.`);
      }

      trace.push({
        id: attempts === 1 ? "prompt" : `prompt-${attempts}`,
        label: `Prompt built and sent to the LLM${attemptTag}`,
        status: planTrace.systemPrompt ? "ok" : "skipped",
        summary: planTrace.systemPrompt
          ? `Schema + relationships + question${feedback ? " + feedback on the previous plan" : ""} sent to ${planTrace.model ?? "the model"}`
          : "No LLM call — no API key available",
        detail: planTrace.systemPrompt
          ? `SYSTEM PROMPT\n${planTrace.systemPrompt}\n\n─────────────\n\nUSER MESSAGE\n${planTrace.userPrompt ?? ""}`
          : undefined,
      });

      trace.push({
        id: attempts === 1 ? "llm" : `llm-${attempts}`,
        label: `LLM returned a ${rawSelection ? "selection" : "query plan"}${attemptTag}`,
        status: planTrace.usedHeuristicFallback ? "warn" : "ok",
        summary: planTrace.usedHeuristicFallback
          ? "Fell back to the deterministic keyword planner"
          : `${planTrace.model ?? "model"} returned a ${rawSelection ? "selection (joins left to the compiler)" : "structured plan"}`,
        detail: planTrace.usedHeuristicFallback ? planTrace.fallbackReason : planTrace.rawResponse,
        payload: rawPlan,
        payloadLabel: rawSelection ? "Plan compiled from the selection (before any corrections)" : "Parsed plan (before any corrections)",
        ms: planTrace.ms,
      });

      // A small open-weight planner slips in predictable ways (join key that
      // only exists on one side, dropped groupBy, chart pointed at a column
      // the plan won't produce). Repair those deterministically from the
      // schema before executing, so the answer doesn't depend on how the
      // model happened to sample this time.
      const validated = validateAndRepairPlan(rawPlan, question, schemaDatasets, session.relationships);
      plan = validated.plan;
      repairs = validated.repairs;

      trace.push({
        id: attempts === 1 ? "validate" : `validate-${attempts}`,
        label: `Deterministic plan validation${attemptTag}`,
        status: repairs.length > 0 ? "warn" : "ok",
        summary: repairs.length > 0
          ? `${repairs.length} correction${repairs.length === 1 ? "" : "s"} applied to the model's plan`
          : "Plan passed every schema check unchanged",
        detail: repairs.length > 0
          ? repairs.map((r) => `• [${r.field}] ${r.detail}`).join("\n")
          : "Checked against the schema: base dataset exists, join keys exist on both sides (following multi-hop chains), every filter/groupBy/aggregation column resolves, aggregates only run on numeric columns, derived expressions reference real columns, unused joins pruned, and the chart points at columns the plan will actually produce.",
      });

      assessment = assessPlan(question, plan, repairs, availableColumnNames, {
        link,
        relationships: session.relationships,
        // Every table any sub-plan reaches counts: a multi-fact selection
        // covers its second table in a sibling plan, not in this one.
        planDatasetIds: [
          plan.datasetId,
          ...(plan.joins ?? []).map((j) => j.datasetId),
          ...extraPlans.flatMap((p) => [p.datasetId, ...(p.joins ?? []).map((j) => j.datasetId)]),
          ...compileExcluded,
        ],
        nameOf,
        datasets: plannerDatasets,
        longFormats: semanticModel.longFormats,
        ...(rawSelection ? { aliasOf } : {}),
      });
      if (!firstAttempt) firstAttempt = { plan, repairs, assessment };

      trace.push({
        id: attempts === 1 ? "answer-check" : `answer-check-${attempts}`,
        label: `Can this plan answer the question?${attemptTag}`,
        status: assessment.ok ? "ok" : "warn",
        summary: assessment.ok
          ? "Yes — its shape matches what was asked"
          : attempts < MAX_PLAN_ATTEMPTS && !planTrace.usedHeuristicFallback
            ? `No — ${assessment.problems.length} problem${assessment.problems.length === 1 ? "" : "s"}; asking the planner again with this feedback`
            : `No — ${assessment.problems.length} problem${assessment.problems.length === 1 ? "" : "s"}, and no attempts left`,
        detail: assessment.ok
          ? "Checked: a question for a total/count/average has an aggregation; a formula spelled out in the question is computed; nothing the plan depended on had to be dropped."
          : [...assessment.problems.map((p) => `• ${p}`), "", "Feedback for the retry:", ...assessment.hints.map((h) => `→ ${h}`)].join("\n"),
      });

      if (assessment.ok || planTrace.usedHeuristicFallback) break;
      // The model has said the data it was shown can't answer this. More
      // attempts with the same data cost calls and change nothing; its own
      // explanation is the right thing to show.
      // ...unless the plan simply failed to reach a column the question
      // names. Then the model is wrong that the data can't answer, the exact
      // join path is in the feedback, and asking again is the right move.
      if (plannerSaysUnanswerable(rawSelection?.reasoning ?? rawPlan.reasoning) && !assessment.unreachableColumns) {
        trace.push({
          id: `answer-check-stop-${attempts}`,
          label: "Retry skipped",
          status: "warn",
          summary: "The planner said the selected data cannot answer this question, so no further attempts were made",
          detail: rawSelection?.reasoning ?? rawPlan.reasoning,
        });
        break;
      }
      feedback = retryFeedback((rawSelection ?? rawPlan) as QueryPlan, assessment);
    }

    const planningWarnings: string[] = [];
    const schemaRepairCount = repairs.length;

    // A keyword-planned answer is a guess at what the question meant. It
    // has to be labelled as one everywhere the number appears — including
    // in what the explainer is told, or it will narrate the guess as if it
    // were the answer ("order value, as represented by resolution time").
    if (planTrace.usedHeuristicFallback) {
      const what = [
        ...(plan.aggregations ?? []).map((a) => `${a.fn} of "${a.column}"`),
        ...(plan.groupBy?.length ? [`grouped by ${plan.groupBy.join(", ")}`] : []),
      ].join(", ");
      const base = selected.find((d) => d.id === plan.datasetId)?.name ?? plan.datasetId;
      planningWarnings.push(
        `The AI planner did not produce a usable plan (${planTrace.fallbackReason ?? "unknown reason"}). A keyword-based fallback answered from "${base}"${what ? ` with ${what}` : ""} — this was chosen by matching words, not by understanding the question, and may not be what you asked. Try rephrasing, or name the file and column you mean.`
      );
    } else if (!assessment.ok && firstAttempt) {
      // Every attempt failed the check: fall back to the model's first,
      // unsteered plan and say so.
      plan = firstAttempt.plan;
      repairs = firstAttempt.repairs;
      planningWarnings.push(
        `After ${Math.min(attempts, MAX_PLAN_ATTEMPTS)} planning attempts the plan may still not match what was asked (${firstAttempt.assessment.problems[0]}). The first plan is shown; check the Steps tab.`
      );
    }

    const target = selected.find((d) => d.id === plan.datasetId) ?? selected[0];
    const byId = new Map(selected.map((d) => [d.id, d]));

    const joinWarnings: string[] = [];
    // A statistic over a table that grades its own rows (a QC flag column)
    // includes every grade unless the plan filters on it — say so.
    if (plan.aggregations?.some((a) => a.fn !== "count" && a.fn !== "countDistinct")) {
      const planTables = new Set([plan.datasetId, ...(plan.joins ?? []).map((j) => j.datasetId)]);
      const filteredCols = new Set((plan.filters ?? []).map((f) => f.column));
      for (const q of semanticModel.qualityFlags) {
        if (!planTables.has(q.datasetId) || filteredCols.has(q.column)) continue;
        joinWarnings.push(`Note: "${nameOf(q.datasetId)}" grades its rows with "${q.column}" (${q.values.join(" | ")}); this figure includes rows of every grade. Ask for a specific ${q.column} if only validated rows should count.`);
      }
    }
    const joinSteps: string[] = [];
    const planColumnRefs = new Set(referencedColumns(plan));
    // Which joins genuinely did not run. Tracked explicitly because the
    // "Source" panel used to infer this by checking whether any warning
    // mentioned the dataset's name — which silently mislabelled a successful
    // join as failed as soon as a warning merely referred to that file.
    const failedJoinIds = new Set<string>();
    let workingRows = await ensureDatasetRows(target);
    const baseRowCount = workingRows.length;
    for (const join of plan.joins ?? []) {
      const joinDataset = byId.get(join.datasetId);
      if (!joinDataset || joinDataset.id === target.id) continue;

      const leftKey = join.leftOn ?? join.on;
      const rightKey = join.rightOn ?? join.on;
      if (!leftKey || !rightKey) {
        joinWarnings.push(`Skipped joining "${joinDataset.name}" — no join column was specified.`);
        failedJoinIds.add(joinDataset.id);
        continue;
      }

      const joinRowsData = await ensureDatasetRows(joinDataset);
      const before = workingRows.length;
      const stats: JoinStats = {
        baseRows: 0, outputRows: 0, unmatchedBaseRows: 0,
        maxMatchesPerBaseRow: 0, collidedColumns: [],
      };
      try {
        workingRows = joinRows(workingRows, joinRowsData, joinDataset.name, leftKey, rightKey, join.type ?? "inner", stats);
        joinSteps.push(
          `${join.type ?? "inner"} join "${joinDataset.name}" on ${leftKey} = ${rightKey} → ${before.toLocaleString()} rows became ${workingRows.length.toLocaleString()}`
        );
        if (stats.maxMatchesPerBaseRow > 1) {
          joinSteps.push(
            `  ↳ one-to-many: a single row matched up to ${stats.maxMatchesPerBaseRow} rows in "${joinDataset.name}"`
          );
        }
        if (stats.duplicateKeysDropped) {
          const n = stats.duplicateKeysDropped;
          joinSteps.push(`  ↳ "${joinDataset.name}" repeats ${n} ${rightKey} value${n === 1 ? "" : "s"} that should be unique; the first row of each was used so nothing is counted twice`);
          joinWarnings.push(`Note: "${joinDataset.name}" contains ${n} duplicated ${rightKey} record${n === 1 ? "" : "s"}; only the first occurrence was used in the join, so figures are not double-counted.`);
        }
        if (stats.unmatchedBaseRows > 0) {
          joinSteps.push(
            `  ↳ ${stats.unmatchedBaseRows.toLocaleString()} row${stats.unmatchedBaseRows === 1 ? "" : "s"} found no match` +
              (join.type === "left" ? " (kept, joined columns blank)" : " and were dropped by the inner join")
          );
        }
        // A column name present on both sides is a real trap: the base keeps
        // the bare name, so a plan that says "amount" gets the base's amount
        // no matter which one the question meant.
        for (const c of stats.collidedColumns) {
          joinSteps.push(
            `  ↳ both sides have "${c.column}" — "${target.name}"'s kept that name, "${joinDataset.name}"'s became "${c.renamedTo}"`
          );
          if (planColumnRefs.has(c.column)) {
            joinWarnings.push(
              `Both "${target.name}" and "${joinDataset.name}" have a column called "${c.column}", and this query uses it — it resolved to "${target.name}"'s. If you meant the other one, ask for "${c.renamedTo}".`
            );
          }
        }
      } catch (err) {
        if (err instanceof JoinKeyMissingError) {
          joinWarnings.push(
            `Could not join "${joinDataset.name}" (${err.message}) — results below only reflect "${target.name}".`
          );
          joinSteps.push(`SKIPPED join to "${joinDataset.name}" — ${err.message}`);
          failedJoinIds.add(joinDataset.id);
          continue;
        }
        throw err;
      }
    }

    // A join that multiplies rows also duplicates every base-side value it
    // carries along. Summing one of the base's own columns afterwards reports
    // a figure several times too large, and the number itself looks entirely
    // plausible — this is the quiet way a multi-file answer goes wrong.
    // countDistinct/min/max are unaffected by duplication, so they aren't flagged.
    if (workingRows.length > baseRowCount) {
      const baseColumns = new Set(target.columns.map((c) => c.name));
      const distorted = (plan.aggregations ?? []).filter(
        (a) => (a.fn === "sum" || a.fn === "avg" || a.fn === "count") && baseColumns.has(a.column)
      );
      if (distorted.length > 0) {
        const list = distorted.map((a) => `${a.fn}(${a.column})`).join(", ");
        joinWarnings.push(
          `The join expanded "${target.name}" from ${baseRowCount.toLocaleString()} to ${workingRows.length.toLocaleString()} rows, so each of its rows now appears more than once. ${list} ${distorted.length === 1 ? "is" : "are"} taken over "${target.name}"'s own column${distorted.length === 1 ? "" : "s"}, so ${distorted.length === 1 ? "that figure counts" : "those figures count"} the same underlying value repeatedly.`
        );
      }
    }

    trace.push({
      id: "join",
      label: "Datasets loaded and joined",
      status: joinWarnings.length > 0 ? "warn" : joinSteps.length > 0 ? "ok" : "skipped",
      summary: joinSteps.length > 0
        ? `${target.name} + ${joinSteps.length} join${joinSteps.length === 1 ? "" : "s"} → ${workingRows.length.toLocaleString()} rows`
        : `Single dataset "${target.name}" — no joins needed`,
      detail: [`Base: ${target.name} (${baseRowCount.toLocaleString()} rows)`, ...joinSteps, ...joinWarnings].join("\n"),
      rowsIn: baseRowCount,
      rowsOut: workingRows.length,
    });

    // Second validation pass, now that real values are available: catch a
    // filter the question asked for that the plan dropped (schema alone
    // can't see this — the filter value lives in the data).
    // In selection mode the planner chose its filters from a menu that lists
    // every value of every low-cardinality column; adding filters behind its
    // back would override that choice. For a legacy plan the check stays,
    // minus any word that also names a column in scope.
    if (!rawSelection) {
      const reserved = link.columns.filter((c) => c.strength === "strong").flatMap((c) => c.term.split(/\s+/));
      const withFilters = injectMissingValueFilters(plan, question, workingRows, reserved);
      Object.assign(plan, withFilters.plan);
      repairs.push(...withFilters.repairs);
    }

    const withDateYears = correctHallucinatedDateFilterYear(plan, workingRows);
    Object.assign(plan, withDateYears.plan);
    repairs.push(...withDateYears.repairs);

    const withTimeFilters = resolveTimeFilters(plan, question, workingRows);
    Object.assign(plan, withTimeFilters.plan);
    repairs.push(...withTimeFilters.repairs);

    const withRangeFilters = dropUnsatisfiableRangeFilters(plan, workingRows);
    Object.assign(plan, withRangeFilters.plan);
    repairs.push(...withRangeFilters.repairs);

    const dataRepairs = repairs.slice(schemaRepairCount);
    trace.push({
      id: "revalidate",
      label: "Re-checked against the real data",
      status: dataRepairs.length > 0 ? "warn" : "ok",
      summary: dataRepairs.length > 0
        ? `${dataRepairs.length} correction${dataRepairs.length === 1 ? "" : "s"} only visible once actual values were loaded`
        : "No value-level problems found (filters match the data's real format)",
      detail: dataRepairs.length > 0
        ? dataRepairs.map((r) => `• [${r.field}] ${r.detail}`).join("\n")
        : "Checked for: filters the question asked for but the plan omitted, hallucinated years, month names written as text against YYYY-MM columns, and range filters whose format matches nothing.",
    });

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

    // The planner sometimes says outright that it couldn't express the
    // question and substituted a narrower one. That admission must reach
    // the user — it's the difference between an approximation and a lie.
    const hedgeWarning = detectPlannerHedging(plan.reasoning);

    trace.push({
      id: "guard",
      label: "Concept guard",
      status: conceptWarnings.length > 0 ? "warn" : "ok",
      summary: conceptWarnings.length > 0
        ? `${conceptWarnings.length} concept in this question isn't present in the data`
        : "Question asks only for things these columns actually measure",
      detail: conceptWarnings.length > 0
        ? conceptWarnings.map((w) => `• ${w.message}`).join("\n")
        : "Checked whether the question asks for profit/margin, churn, satisfaction, a forecast, or causation without the columns that would support it.",
    });

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
    // Which files this answer actually drew on — needed because the same
    // column name can exist in several of them.
    const datasetsInPlay = new Set<string>([target.name]);
    for (const join of plan.joins ?? []) {
      const jd = byId.get(join.datasetId);
      if (jd && !failedJoinIds.has(jd.id)) datasetsInPlay.add(jd.name);
    }

    const describeCandidate = (c: { column: string; datasetName: string }) =>
      `"${c.column}" (${c.datasetName})`;

    const ambiguityNotes = preAmbiguity.flatMap((w) => {
      // Candidates are identified by column AND file: two files can each have
      // an "amount", and comparing on the name alone treated those as one
      // candidate, which silently suppressed the very warning that case needs.
      const used =
        w.candidates.find((c) => usedColumnNames.has(c.column) && datasetsInPlay.has(c.datasetName)) ??
        w.candidates.find((c) => usedColumnNames.has(c.column));
      if (!used) return [];
      const others = w.candidates.filter(
        (c) => c.column !== used.column || c.datasetName !== used.datasetName
      );
      if (others.length === 0) return [];
      return [
        `"${w.concept}" could mean ${w.candidates.map(describeCandidate).join(" or ")} — this answer uses ${describeCandidate(used)}.`,
      ];
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

    const executeStarted = Date.now();
    let execution = executeQueryPlan(workingRows, plan);

    // Multi-fact: run every sibling plan the same way (validate → join →
    // execute) and merge the aggregated results on the dimension values.
    let pandasExtra = "";
    if (extraPlans.length > 0) {
      const parts = [{ columns: execution.columns, rows: execution.rows }];
      const subSteps: string[] = [];
      for (const sub of extraPlans) {
        const v = validateAndRepairPlan(sub, question, schemaDatasets, session.relationships);
        const subBase = selected.find((d) => d.id === v.plan.datasetId);
        if (!subBase) continue;
        let subRows = await ensureDatasetRows(subBase);
        for (const j of v.plan.joins ?? []) {
          const jd = byId.get(j.datasetId);
          const lk = j.leftOn ?? j.on, rk = j.rightOn ?? j.on;
          if (!jd || !lk || !rk) continue;
          try { subRows = joinRows(subRows, await ensureDatasetRows(jd), jd.name, lk, rk, j.type ?? "inner"); }
          catch (err) { if (err instanceof JoinKeyMissingError) continue; throw err; }
        }
        const subExec = executeQueryPlan(subRows, v.plan);
        parts.push({ columns: subExec.columns, rows: subExec.rows });
        subSteps.push(`${subBase.name}: ${(v.plan.aggregations ?? []).map((a) => `${a.fn}(${a.column})`).join(", ")} over ${subRows.length.toLocaleString()} rows → ${subExec.rows.length} group(s)`);
        pandasExtra += "\n\n# ── second fact table, aggregated separately ──\n" + planToPandas(v.plan, selected.map((d) => ({ id: d.id, name: d.name }))).replace(/^import pandas as pd\n+/, "").replace(/\bresult\b/g, `result_${subBase.name.replace(/[^a-zA-Z0-9]+/g, "_")}`);
      }
      const merged = mergeAggregatedResults(parts, mergeDimensionCount);
      // A "having" over columns that only exist once the parts sit side by
      // side ("actual at least target") is applied here, on the merged rows.
      let mergedRows = merged.rows;
      for (const h of plan.having ?? []) {
        if (!merged.columns.includes(h.column) || (h.compareTo && !merged.columns.includes(h.compareTo))) continue;
        const before = mergedRows.length;
        mergedRows = mergedRows.filter((row) => {
          const cell = row[h.column]; const other = h.compareTo ? row[h.compareTo] : h.value;
          if (typeof cell !== "number" || (h.compareTo && typeof other !== "number")) return false;
          const v = Number(other);
          return h.op === "gt" ? cell > v : h.op === "gte" ? cell >= v : h.op === "lt" ? cell < v : h.op === "lte" ? cell <= v : h.op === "neq" ? cell !== v : cell === v;
        });
        if (mergedRows.length !== before) joinWarnings.push(`Kept ${mergedRows.length} of ${before} merged rows where ${h.column} ${h.op} ${h.compareTo ?? h.value}.`);
      }
      execution = { ...execution, columns: merged.columns, rows: mergedRows };
      // A correlation between measures of DIFFERENT tables only exists once
      // they sit side by side — compute it here, on the merged rows.
      const corr = plan.correlate;
      if (corr && !execution.correlation && merged.columns.includes(corr.columnX) && merged.columns.includes(corr.columnY)) {
        const r = computePearsonCorrelation(merged.rows, corr.columnX, corr.columnY);
        if (r) execution = {
          ...execution,
          correlation: { columnX: corr.columnX, columnY: corr.columnY, coefficient: r.coefficient, sampleSize: r.sampleSize, interpretation: interpretCorrelation(r.coefficient) },
          // The sub-plan could not see the other table's measure; the merge could.
          warnings: execution.warnings.filter((w) => !/Could not compute correlation/.test(w)),
        };
      }
      trace.push({
        id: "merge",
        label: "Fact tables aggregated separately and merged",
        status: "ok",
        summary: `${parts.length} aggregations merged on ${mergeDimensionCount} dimension${mergeDimensionCount === 1 ? "" : "s"} → ${merged.rows.length} row${merged.rows.length === 1 ? "" : "s"}`,
        detail: [
          "Totals from different tables are never joined row-by-row (that multiplies one side and drops the other's unmatched rows). Each table is aggregated on its own at the requested grouping, then the results are placed side by side.",
          ...subSteps,
        ].join("\n"),
      });
      if (mergeDimensionCount > 0) pandasExtra += `\n\nresult = result.merge(${parts.length > 1 ? "result_2" : "result"}, how="outer", on=[${merged.columns.slice(0, mergeDimensionCount).map((c) => JSON.stringify(c)).join(", ")}])  # align the separately-aggregated tables on their dimensions`;
    }
    const executeMs = Date.now() - executeStarted;

    const pandasCode = planToPandas(plan, selected.map((d) => ({ id: d.id, name: d.name }))) + pandasExtra;

    trace.push({
      id: "execute",
      label: "Plan executed deterministically",
      status: execution.warnings.length > 0 ? "warn" : "ok",
      summary: `Ran on real rows — no LLM involved in the arithmetic`,
      detail: [
        "Final plan (the exact operations that ran, in order):",
        ...(plan.derive ?? []).map((d) => `• derive ${d.as} = ${d.expr}`),
        ...(plan.filters ?? []).map((f) => `• filter ${f.column} ${f.op} ${JSON.stringify(f.value)}`),
        ...(plan.dateBucket ? [`• bucket ${plan.dateBucket.column} by ${plan.dateBucket.granularity}`] : []),
        ...(plan.groupBy?.length ? [`• group by ${plan.groupBy.join(", ")}`] : []),
        ...(plan.aggregations ?? []).map((a) => `• aggregate ${a.fn}(${a.column}) as ${a.as ?? `${a.fn}_${a.column}`}`),
        ...(plan.having ?? []).map((h) => `• keep only groups where ${h.column} ${h.op} ${JSON.stringify(h.value)}`),
        ...(plan.sort ?? []).map((s) => `• sort ${s.column} ${s.direction}`),
        ...(plan.limit ? [`• limit ${plan.limit}`] : []),
        ...(plan.correlate ? [`• correlate ${plan.correlate.columnX} vs ${plan.correlate.columnY}`] : []),
        ...execution.warnings.map((w) => `⚠ ${w}`),
      ].join("\n"),
      payload: plan,
      payloadLabel: "Final plan (after every correction)",
      ms: executeMs,
      rowsIn: workingRows.length,
      rowsOut: execution.rows.length,
    });

    trace.push({
      id: "pandas",
      label: "Pandas equivalent",
      status: "ok",
      summary: "The same operations expressed as pandas code",
      detail: pandasCode,
    });

    const joinsUsed: string[] = [];
    const filesUsed = [target.name];
    for (const join of plan.joins ?? []) {
      const joinDataset = byId.get(join.datasetId);
      if (!joinDataset || joinDataset.id === target.id) continue;
      const leftKey = join.leftOn ?? join.on;
      const rightKey = join.rightOn ?? join.on;
      if (!leftKey || !rightKey) continue;
      // Only report joins that actually ran.
      if (failedJoinIds.has(joinDataset.id)) continue;
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

    const explainTrace: LlmCallTrace = {};
    const { explanation, followUpSuggestions } = await explainResults(
      question,
      execution.rows,
      execution.columns,
      execution.correlation,
      [
        ...conceptWarnings.map((w) => w.message),
        ...(hedgeWarning ? [hedgeWarning] : []),
        // Only present when the keyword fallback ran — on a normal run the
        // explainer's prompt is exactly what it was before.
        ...(planTrace.usedHeuristicFallback
          ? ["this result came from a keyword-based fallback, not from understanding the question — say plainly that it may not answer what was asked, and do not describe the computed column as if it were the quantity the question named"]
          : []),
      ],
      apiKey,
      explainTrace
    );

    trace.push({
      id: "explain",
      label: "Results sent back to the LLM for a plain-English summary",
      status: explainTrace.usedHeuristicFallback ? "warn" : "ok",
      summary: explainTrace.usedHeuristicFallback
        ? "Fell back to a templated summary"
        : `${explainTrace.model ?? "model"} saw ${Math.min(execution.rows.length, 20)} preview row${Math.min(execution.rows.length, 20) === 1 ? "" : "s"} (plus the true total), never the raw files`,
      detail: explainTrace.usedHeuristicFallback
        ? explainTrace.fallbackReason
        : [
            explainTrace.userPrompt ? `USER MESSAGE\n${explainTrace.userPrompt}` : "",
            explainTrace.rawResponse ? `\n─────────────\n\nRAW MODEL RESPONSE\n${explainTrace.rawResponse}` : "",
          ].filter(Boolean).join("\n"),
      ms: explainTrace.ms,
    });

    // A grouped result with one dimension and a numeric measure is a chart
    // whether or not the model asked for one: a bar per category, a line
    // when the dimension is a date bucket. Lists, scalars and raw rows are
    // left alone. Recorded as a repair so the trace says it was a default.
    // Two grouping columns count as one dimension when the second is the
    // first's readable label (an id and its name have the same groups).
    const groupDims = plan.groupBy ?? [];
    const oneDimension = groupDims.length === 1 || (groupDims.length === 2 && execution.rows.length === new Set(execution.rows.map((r) => String(r[groupDims[0]]))).size);
    if ((!plan.chartType || plan.chartType === "none") && oneDimension && execution.rows.length >= 2 && execution.rows.length <= 40) {
      // Chart the readable column when there is one (a name over an id).
      const dim = groupDims.length === 2 && execution.rows.every((r) => typeof r[groupDims[1]] === "string") ? groupDims[1] : groupDims[0];
      const measure = execution.columns.find((c) => !groupDims.includes(c) && execution.rows.every((r) => typeof r[c] === "number"));
      if (measure) {
        const isTime = plan.dateBucket?.as === dim || plan.dateBucket?.column === dim || execution.rows.every((r) => /^\d{4}(-\d{2})?/.test(String(r[dim] ?? "")));
        plan.chartType = isTime ? "line" : "bar";
        plan.chartX = dim;
        plan.chartY = [measure];
        repairs.push({ field: "chartType", detail: `Added a ${plan.chartType} chart of "${measure}" by "${dim}" — the model asked for none, but a grouped result with one dimension is a chart.` });
      }
    }

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
        ...scopeWarnings.map((w) => `Important: ${w}`),
        ...selected.flatMap((d) => (d.notes ?? []).map((n) => `Note (${d.name}): ${n}`)),
        ...planningWarnings.map((w) => `Important: ${w}`),
        ...compileWarnings.map((w) => `Important: ${w}`),
        ...conceptWarnings.map((w) => `Important: ${w.message}.`),
        ...(hedgeWarning ? [`Important: ${hedgeWarning}`] : []),
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
      trace,
      pandasCode,
    };

    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Keep whatever stages completed before the failure — knowing it died
    // after the join but before execution is far more useful than a bare
    // error string.
    trace.push({
      id: "error",
      label: "Pipeline stopped",
      status: "warn",
      summary: message,
      detail: err instanceof Error ? err.stack : undefined,
    });
    const result: QueryResult = {
      id: queryId,
      question,
      timestamp: new Date(),
      status: "error",
      errorMessage: message,
      trace,
    };
    return NextResponse.json({ result }, { status: 200 });
  }
}
