import { QueryPlan } from "./types";
import { PlanRepair } from "./plan-validator";

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
}

// Wording that asks for ONE summarised figure. Ranking words ("highest",
// "most", "top") are left out on purpose: "the 3 highest paid employees"
// is correctly a row ranking with no aggregation.
const WANTS_AGGREGATE = /\b(total|sum of|how many|number of|count of|average|avg|mean|overall)\b/i;

// A formula given in the question itself: "revenue = qty × price × (1 − d%)".
const SPELLS_OUT_FORMULA = /\b([a-z_ ]{3,30})\s*=\s*[a-z_ ]+\s*[×x*\/+\-]/i;

const MATERIAL_DROP = /^Dropped (derived column|sum|avg|min|max|countDistinct|count|join to|groupBy|filter on unknown)/i;

// A question asking for a "value"/"amount"/"total"/"worth" — an outcome, not
// a rate. "Average unit price" is deliberately excluded: naming the rate
// directly IS asking for the rate.
const WANTS_VALUE = /\b(value|worth|amount)\b/i;

// A column name that is itself a PER-UNIT rate, not a total — the standard
// "price"/"rate"/"cost" naming family, qualified as per-unit. Matches
// "unit_price", "price_per_unit", "rate_per_unit", "unit_cost", generically
// across any inventory/sales schema, not a specific file's column names.
const LOOKS_LIKE_UNIT_RATE = /\bunit[_ ]?(price|cost|rate)\b|\b(price|cost|rate)[_ ]?per[_ ]?unit\b/i;

// A column name that looks like a quantity/count to multiply the rate by.
const LOOKS_LIKE_QUANTITY = /\b(qty|quantity|units?|count)\b/i;

export function assessPlan(
  question: string,
  plan: QueryPlan,
  repairs: PlanRepair[],
  availableColumns: string[]
): PlanAssessment {
  const problems: string[] = [];
  const hints: string[] = [];
  const hasAggregation = (plan.aggregations?.length ?? 0) > 0;

  // 1. A question for a figure, answered with rows.
  if (WANTS_AGGREGATE.test(question) && !hasAggregation && !plan.correlate) {
    problems.push("The question asks for a summarised figure (a total / count / average), but the plan has no \"aggregations\" entry, so it would return raw rows instead of that figure.");
    hints.push("Add an \"aggregations\" entry for each figure asked for (sum for a total, count or countDistinct for how many, avg for an average). Only add \"groupBy\" if the question asks for a breakdown \"by\" something.");
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
  if (WANTS_VALUE.test(question) && !(plan.derive?.length)) {
    const rateAgg = (plan.aggregations ?? []).find(
      (a) => (a.fn === "sum" || a.fn === "avg") && LOOKS_LIKE_UNIT_RATE.test(a.column)
    );
    const quantityColumn = availableColumns.find((c) => LOOKS_LIKE_QUANTITY.test(c));
    if (rateAgg && quantityColumn) {
      problems.push(
        `The question asks for a "value"/"amount", but the plan directly ${rateAgg.fn}s "${rateAgg.column}", which is a per-unit rate, not a value — and "${quantityColumn}" exists to multiply it by.`
      );
      hints.push(
        `A "value" is usually rate × quantity. Add a "derive" entry (e.g. "order_value") whose "expr" multiplies "${rateAgg.column}" by "${quantityColumn}" (and by any discount/tax column the same way, if one exists), then aggregate the derived column instead of "${rateAgg.column}" directly.`
      );
    }
  }

  return { ok: problems.length === 0, problems, hints };
}

/** The extra block appended to the planner prompt on a retry. */
export function retryFeedback(previous: QueryPlan, assessment: PlanAssessment): string {
  return [
    "",
    "─────────────",
    "Your previous plan did not answer the question. It was:",
    JSON.stringify(previous),
    "",
    "What was wrong with it:",
    ...assessment.problems.map((p) => `- ${p}`),
    "",
    "How to fix it:",
    ...assessment.hints.map((h) => `- ${h}`),
    "",
    "Output the corrected plan now, as JSON only. Do not explain, do not list options, and do not fall back to a narrower question — answer this one directly.",
  ].join("\n");
}
