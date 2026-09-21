import { ColumnSchema, QueryPlan } from "./types";
import { PlanRepair } from "./plan-validator";
import { SchemaLink, findJoinPath, unreachableLinkedColumns } from "./schema-linking";
import { RelationshipRecord } from "./session-store";

/**
 * Decides, without a model, whether a validated plan can answer the question
 * at all — and if not, what to tell the planner so its next attempt is a
 * corrected plan rather than another hedge.
 *
 * This is deliberately narrow. Every check here is a SHAPE mismatch that has
 * no correct reading: a question for a single total answered with a row
 * dump, a formula the question spelled out that the plan never computed, a
 * capability the validator had to strip because the plan referenced
 * something that doesn't exist, or a "value/total/amount" answered with a
 * bare per-unit rate while the quantity to multiply it by sits unused right
 * next to it. None of these require knowing what the model SHOULD have
 * chosen among several reasonable options — that judgement stays the
 * model's, and second-guessing it is how a right answer gets replaced with
 * a wrong one.
 */
export interface PlanAssessment {
  ok: boolean;
  /** What was wrong, in the terms the planner will be shown. */
  problems: string[];
  /** Concrete corrections, so the retry can go straight to a fixed plan. */
  hints: string[];
  /**
   * The question named a column that exists in a file the plan never
   * reached. Set so the caller keeps retrying even if the model claimed the
   * data cannot answer — the data can; the plan just didn't reach it.
   */
  unreachableColumns?: number;
}

// Wording that asks for ONE summarised figure. Ranking words ("highest",
// "most", "top") are left out on purpose: "the 10 longest books"
// is correctly a row ranking with no aggregation.
const WANTS_AGGREGATE = /\b(total|sum of|how many|number of|count of|average|avg|mean|overall)\b/i;

// A formula given in the question itself: "billed = units × rate × (1 + tax%)".
const SPELLS_OUT_FORMULA = /\b([a-z_ ]{3,30})\s*=\s*[a-z_ ]+\s*[×x*\/+\-]/i;

const MATERIAL_DROP = /^Dropped (derived column|sum|avg|median|min|max|countDistinct|count|join to|groupBy|filter on unknown)/i;

// A question asking for a "value"/"amount"/"worth"/"revenue"/"turnover" — an
// outcome, not a rate. "Average unit price" is deliberately excluded: naming
// the rate directly IS asking for the rate. "sales" is deliberately excluded
// too — "average sales" is genuinely ambiguous between a money total and a
// count of transactions, so guessing which one is meant would be exactly
// the kind of override this file exists to avoid.
const WANTS_VALUE = /\b(value|worth|amount|revenue|turnover)\b/i;

// "in both cycles", "in every quarter", "across all three terms": an entity
// qualifies only if it meets the condition in EACH period — a groupBy over
// the entity with a count of periods and a "having", never a row filter.
const ACROSS_ALL_PERIODS = /\bboth\b[^.?]{0,40}?\b(cycles?|periods?|quarters?|months?|years?|weeks?|terms?|semesters?|seasons?|rounds?|halves|waves?)\b|\ball\s+(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+\s+)?(cycles?|periods?|quarters?|months?|years?|weeks?|terms?|semesters?|seasons?|rounds?|halves|waves?)\b/i;
// "correlation between", "is X related to Y"
const WANTS_CORRELATION = /\bcorrelat|\brelationship between\b|\brelated to\b|\bassociated with\b/i;
// "when/where/which … highest/peak": the row at one end of a ranking.
const WANTS_TOP = /\b(highest|largest|biggest|maximum|max|peak|most|top|greatest|latest|newest|longest)\b/i;
const WANTS_BOTTOM = /\b(lowest|smallest|minimum|min|least|bottom|fewest|earliest|oldest|shortest)\b/i;
// "the most … and the least …": both ends of a ranking in one answer.
const BOTH_EXTREMES = /\b(most|highest|largest|biggest|top|best)\b[^.?]*\b(and|vs\.?|versus|as well as)\b[^.?]*\b(least|lowest|smallest|bottom|worst)\b|\b(least|lowest|smallest|bottom|worst)\b[^.?]*\b(and|vs\.?|versus|as well as)\b[^.?]*\b(most|highest|largest|biggest|top|best)\b/i;

// A column name that is itself a PER-UNIT rate, not a total — the standard
// "price"/"rate"/"cost" naming family, qualified as per-unit. Matches
// "unit_price", "price_per_unit", "rate_per_unit", "unit_cost", generically
// across any inventory/sales schema, not a specific file's column names.
const LOOKS_LIKE_UNIT_RATE = /\bunit[_ ]?(price|cost|rate|fee)\b|\b(price|cost|rate|fee|charge)[_ ]?per[_ ]?[a-z]+\b|\b(price|cost|rate|fee|charge)_per\b/i;
/** The quantity a "…_per_<x>" rate applies to: a column named like <x> (seat → seats). */
function quantityFor(rateColumn: string, columns: string[]): string | undefined {
  const per = /per[_ ]?([a-z]+)/i.exec(rateColumn)?.[1]?.toLowerCase();
  if (per && per !== "unit") {
    const hit = columns.find((c) => { const n = c.toLowerCase(); return n !== rateColumn.toLowerCase() && (n === per || n === per + "s" || n === per + "es" || n.endsWith("_" + per) || n.endsWith("_" + per + "s")); });
    if (hit) return hit;
  }
  return columns.find((c) => LOOKS_LIKE_QUANTITY.test(c));
}

// A column name that looks like a quantity/count to multiply the rate by.
const LOOKS_LIKE_QUANTITY = /\b(qty|quantity|units?|count)\b/i;

export interface LinkContext {
  link: SchemaLink;
  relationships: RelationshipRecord[];
  /** Dataset ids the validated plan actually reaches: base plus every kept join. */
  planDatasetIds: string[];
  nameOf: (id: string) => string;
  /**
   * In selection mode the planner names menu fields and never writes joins,
   * so hints must say "use field alias.column", not "add a join".
   */
  aliasOf?: (id: string) => string;
  /** Every dataset in scope with its column profiles (distinct values), for value-term checks. */
  datasets?: { id: string; name: string; columns: ColumnSchema[] }[];
  /** Long-format layouts (see semantic-model.ts): the named quantity's number lives in the child's value column. */
  longFormats?: { childId: string; valueColumn: string; valueRef: string; parentId: string; parameterColumn: string; parameterRef: string }[];
}

export function assessPlan(
  question: string,
  plan: QueryPlan,
  repairs: PlanRepair[],
  availableColumns: string[],
  linkContext?: LinkContext
): PlanAssessment {
  const problems: string[] = [];
  const hints: string[] = [];
  const hasAggregation = (plan.aggregations?.length ?? 0) > 0;

  // 1. A question for a figure, answered with rows.
  if (WANTS_AGGREGATE.test(question) && !hasAggregation && !plan.correlate) {
    problems.push("The question asks for a summarised figure (a total / count / average), but the plan has no \"aggregations\" entry, so it would return raw rows instead of that figure.");
    hints.push("Add a measure (an \"aggregations\" entry, or \"measures\" in selection form) for each figure asked for (sum for a total, count or countDistinct for how many, avg for an average). Only group (\"groupBy\"/\"dimensions\") if the question asks for a breakdown \"by\" something.");
  }

  // 2. A formula the question spells out that the plan never computed.
  const formula = question.match(SPELLS_OUT_FORMULA);
  if (formula && !(plan.derive?.length)) {
    const name = formula[1].trim();
    problems.push(`The question defines "${name}" with a formula, but the plan has no "derive" entry computing it.`);
    hints.push(`Add a "derive" entry named "${name.replace(/\s+/g, "_")}" whose "expr" is that formula written over the existing numeric columns (percentages as (1 - pct / 100)), then aggregate the derived column.`);
  }

  // 3. The validator had to strip something the plan depended on.
  const drops = repairs.filter((r) => MATERIAL_DROP.test(r.detail));
  if (drops.length > 0) {
    for (const d of drops) problems.push(d.detail);
    hints.push(`Reference only these columns, exactly as spelled: ${availableColumns.join(", ")}.`);
  }

  // 4. A "value"/"amount"/"total" answered by directly summing/averaging a
  // bare per-unit rate, with no derive and a quantity column sitting right
  // there unused. A rate on its own is not a value — it has to be multiplied
  // by how many units it applies to. This is the one case where "no formula
  // is spelled out in the question" (rule 2 requires literal "x = ...") but
  // the mismatch is still structurally visible: the aggregated column's own
  // name says "per unit" while the question's own word says "value".
  // Summing a per-unit rate is meaningless whatever the question says
  // ("total of price per seat"); averaging one is fine when the question is
  // about the rate itself. So: any question for a sum of a rate, or a
  // value/amount question that averages one.
  const asksAboutTheRate = (col: string) => col.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !["per", "unit"].includes(w)).some((w) => question.toLowerCase().includes(w));
  const rateSum = (plan.aggregations ?? []).find((a) => a.fn === "sum" && LOOKS_LIKE_UNIT_RATE.test(a.column) && !asksAboutTheRate(a.column));
  if ((WANTS_VALUE.test(question) || rateSum) && !(plan.derive?.length)) {
    const rateAgg = rateSum ?? (plan.aggregations ?? []).find(
      (a) => (a.fn === "sum" || a.fn === "avg") && LOOKS_LIKE_UNIT_RATE.test(a.column)
    );
    const quantityColumn = rateAgg ? quantityFor(rateAgg.column, availableColumns) : undefined;
    if (rateAgg && quantityColumn) {
      problems.push(
        `The question asks for a "value"/"amount", but the plan directly ${rateAgg.fn}s "${rateAgg.column}", which is a per-unit rate, not a value — and "${quantityColumn}" exists to multiply it by.`
      );
      hints.push(
        `A "value" is usually rate × quantity. Add a "derive" entry (e.g. "computed_value") whose "expr" multiplies "${rateAgg.column}" by "${quantityColumn}" (and by any discount/tax column the same way, if one exists), then aggregate the derived column instead of "${rateAgg.column}" directly.`
      );
    }
  }

  // 5. The question names a column that the plan cannot reach. "Loans by
  // member city" answered from the loans file alone, grouped by its own
  // "branch": valid, and a different question. Whether "city" is
  // reachable from the plan's datasets is a fact about the schema, not a
  // guess about intent, so it can be checked — and the exact join path can
  // be handed back.
  let unreachableColumns = 0;
  if (linkContext) {
    const missing = unreachableLinkedColumns(linkContext.link, linkContext.planDatasetIds);
    unreachableColumns = missing.length;
    for (const m of missing) {
      const holders = m.datasetIds.map(linkContext.nameOf);
      problems.push(`The question refers to "${m.term}" (column "${m.column}"), which exists only in ${holders.map((h) => `"${h}"`).join(" / ")} — a dataset the plan never uses or joins.`);
      if (linkContext.aliasOf) {
        // Selection mode: the fix is naming the right menu field; the
        // compiler does the join.
        const refs = m.datasetIds.map((id) => `${linkContext.aliasOf!(id)}.${m.column}`);
        hints.push(`Use the menu field ${refs.map((r) => `"${r}"`).join(" or ")} as a dimension, filter or select (the join is made automatically) instead of a similar-sounding column from another table.`);
        continue;
      }
      const base = linkContext.planDatasetIds[0];
      // Several files may hold the concept; point at the one nearest the base.
      const candidates = linkContext.link.conceptHolders.get(m.column.toLowerCase()) ?? m.datasetIds;
      let path: ReturnType<typeof findJoinPath>;
      for (const holder of candidates) {
        const p = base ? findJoinPath(base, holder, linkContext.relationships) : undefined;
        if (p && (!path || p.length < path.length)) path = p;
      }
      hints.push(
        path && path.length > 0
          ? `Keep "${linkContext.nameOf(base)}" as the base and add these joins in order: ${path.map((j, i) => `${i + 1}) "${linkContext.nameOf(j.datasetId)}" leftOn "${j.leftOn}" rightOn "${j.rightOn}"`).join("; ")} — then use "${m.column}" in groupBy/filters/select as the question asks.`
          : `Include "${holders[0]}" in the plan (as the base, or joined through a listed relationship) so that "${m.column}" is available.`
      );
    }
  }

  // 9. The question names a VALUE of a categorical column (a genre, a
  // status, a priority) but the plan never filters on that column: the
  // plan answers for every category at once. Only whole-phrase matches of
  // listed distinct values count; the longest match wins.
  if (linkContext?.datasets) {
    const q = " " + question.toLowerCase().replace(/[^a-z0-9.]+/g, " ") + " ";
    const filtered = new Set((plan.filters ?? []).map((f) => f.column.toLowerCase()));
    // Only tables the plan already reaches: a value found in an unrelated
    // table must not pull that table into the plan.
    const inPlan = new Set(linkContext.planDatasetIds);
    // A word that also names a column of those tables ("renewal" in
    // renewal_date) refers to the column, not to a same-spelled value.
    const columnWords = new Set(linkContext.datasets.filter((d) => inPlan.has(d.id)).flatMap((d) => d.columns.flatMap((c) => c.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))));
    // Likewise a word that names one of the FILES ("maintenance visits" when
    // a maintenance workbook is loaded) refers to that file, not to a
    // same-spelled status value in another table.
    for (const d of linkContext.datasets) for (const w of d.name.toLowerCase().replace(/\.(csv|xlsx)$/i, "").split(/[^a-z0-9]+/)) if (w.length > 2) columnWords.add(w);
    const hits: { value: string; column: string; datasetId: string; span: [number, number] }[] = [];
    for (const ds of linkContext.datasets) {
      if (!inPlan.has(ds.id)) continue;
      for (const c of ds.columns) {
        if (!c.distinctValues || c.distinctValues.length < 2 || c.distinctValues.length > 12) continue;
        for (const v of c.distinctValues) {
          const key = v.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
          if (key.length < 2 || /^\d+(\.\d+)?$/.test(key)) continue;
          if (key.split(" ").every((w) => columnWords.has(w))) continue;
          const at = q.indexOf(" " + key + " ");
          if (at >= 0) hits.push({ value: v, column: c.name, datasetId: ds.id, span: [at, at + key.length + 2] });
        }
      }
    }
    const kept = hits.filter((h) => !hits.some((o) => o !== h && o.span[1] - o.span[0] > h.span[1] - h.span[0] && o.span[0] <= h.span[0] && o.span[1] >= h.span[1]));
    const grouped = new Set((plan.groupBy ?? []).map((g) => g.toLowerCase()));
    const byColumn = new Map<string, typeof kept>();
    for (const h of kept) { const k = `${h.datasetId}|${h.column}`; (byColumn.get(k) ?? byColumn.set(k, []).get(k)!).push(h); }
    for (const [, hs] of byColumn) {
      const h = hs[0];
      // The quantity named is a long-format parameter: the number to
      // aggregate is the child's value column, whether or not a filter exists.
      const lf = (linkContext.longFormats ?? []).find((l) => l.parentId === h.datasetId && l.parameterColumn === h.column);
      if (lf && hs.length === 1) {
        const aggs = plan.aggregations ?? [];
        const aggregatesValue = aggs.some((a) => a.column === lf.valueColumn || a.column.endsWith(`_${lf.valueColumn}`));
        const aggregatesOther = aggs.some((a) => a.fn !== "count" && a.fn !== "countDistinct" && !(a.column === lf.valueColumn || a.column.endsWith(`_${lf.valueColumn}`)));
        if (aggregatesOther && !aggregatesValue) {
          problems.push(`"${h.value}" is a quantity named by "${h.column}"; its numbers are in "${lf.valueColumn}", but the plan aggregates a different column.`);
          hints.push(`Filter ${JSON.stringify({ ref: lf.parameterRef, op: "eq", value: h.value })} and aggregate ${lf.valueRef} (e.g. {"ref": "${lf.valueRef}", "fn": "avg"}) — not another numeric column.`);
          continue;
        }
      }
      if (filtered.has(h.column.toLowerCase())) continue;
      // Several values of one column ("A vs B") is a comparison: grouping by that column answers it.
      if (hs.length > 1 && grouped.has(h.column.toLowerCase())) continue;
      const ref = linkContext.aliasOf ? `${linkContext.aliasOf(h.datasetId)}.${h.column}` : h.column;
      const values = hs.map((x) => x.value);
      problems.push(`The question names ${values.map((v) => `"${v}"`).join(" and ")}, ${values.length > 1 ? "values" : "a value"} of column "${h.column}" in "${linkContext.nameOf(h.datasetId)}", but the plan neither filters nor groups on "${h.column}" — it would answer for every ${h.column} at once.`);
      hints.push(values.length > 1
        ? `Either add "${ref}" as a dimension (to compare ${values.join(" vs ")}) or filter ${JSON.stringify({ ref, op: "in", value: values })}.`
        : `Add a filter ${JSON.stringify({ ref, op: "eq", value: h.value })} (the join is made automatically if that table is not the base) so only rows whose ${h.column} is "${h.value}" are counted.`);
    }
  }

  // 6. "In both/every period" answered with a row filter, or grouped
  // without requiring the number of periods: counts rows, not entities.
  if (ACROSS_ALL_PERIODS.test(question) && !(plan.having?.length)) {
    problems.push("The question asks for entities that meet a condition in EVERY period (\"both\" / \"all\" / \"every\"), but the plan has no \"having\" — a row filter alone counts rows that qualified in ONE period and includes entities that did not qualify in the others.");
    hints.push("Filter the rows to the ones meeting the threshold, groupBy the entity column, add an aggregation countDistinct of the period column (as e.g. \"qualifying_periods\"), then a \"having\" requiring that alias gte the number of periods the question names (2 for \"both\"). The number of result rows is then the count of qualifying entities.");
  }

  // 7. A correlation question with nothing to correlate.
  if (WANTS_CORRELATION.test(question) && !plan.correlate) {
    problems.push("The question asks about a correlation / relationship between two quantities, but the plan has no \"correlate\" entry, so no coefficient can be computed.");
    hints.push("Add \"correlate\": {\"x\": <first numeric column>, \"y\": <second numeric column>} and chartType \"scatter\". If one side is an average PER entity (e.g. an average rating per person), groupBy that entity, aggregate both sides (avg), and correlate the two aggregate \"as\" names.");
  }

  // 10. One end of a ranking asked for, but the plan sorts towards the
  // other end (and keeps the first rows): "the highest reading" sorted
  // ascending returns the lowest.
  const top = WANTS_TOP.test(question), bottom = WANTS_BOTTOM.test(question);
  if (top !== bottom && plan.sort?.length && plan.limit && plan.limit <= 10 && !BOTH_EXTREMES.test(question)) {
    const dir = plan.sort[0].direction;
    if ((top && dir === "asc") || (bottom && dir === "desc")) {
      problems.push(`The question asks for the ${top ? "highest" : "lowest"} but the plan sorts "${plan.sort[0].column}" ${dir === "asc" ? "ascending" : "descending"} and keeps the first ${plan.limit} — that returns the opposite end.`);
      hints.push(`Sort "${plan.sort[0].column}" ${top ? "desc" : "asc"} with the same limit, and keep the columns that say when/where (a timestamp, a name) in "select" so the answer can name them.`);
    }
  }

  // 8. Both ends of a ranking asked for, one row returned.
  if (BOTH_EXTREMES.test(question) && plan.limit === 1) {
    problems.push("The question asks for BOTH the highest and the lowest, but the plan keeps only 1 row, so one end of the ranking is lost.");
    hints.push("Remove the limit (or set it to the number of groups) and keep the sort, so every group is returned in order and both ends are visible; the explanation can then name the first and the last.");
  }

  return { ok: problems.length === 0, problems, hints, ...(unreachableColumns ? { unreachableColumns } : {}) };
}

/** The extra block appended to the planner prompt on a retry. */
export function retryFeedback(previous: QueryPlan, assessment: PlanAssessment): string {
  return [
    "",
    "─────────────",
    "Your previous answer did not answer the question. It was:",
    JSON.stringify(previous),
    "",
    "What was wrong with it:",
    ...assessment.problems.map((p) => `- ${p}`),
    "",
    "How to fix it:",
    ...assessment.hints.map((h) => `- ${h}`),
    "",
    "Output the corrected JSON now, in the same shape as before, JSON only. Do not explain, do not list options, and do not fall back to a narrower question — answer this one directly.",
  ].join("\n");
}
