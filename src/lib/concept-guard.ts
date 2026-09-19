import { ColumnSchema } from "./types";

// Guards against answering a question about a concept the data does not
// contain.
//
// This is the most damaging failure mode observed in testing, because the
// output looks completely normal. Asked "what is our profit margin by
// region?" against a file with no cost column, the planner summed revenue,
// aliased it "total_profit", and the explanation reported it as profit —
// the same figure that the revenue question returns, relabelled. Nothing in
// the table, the chart, or the prose signalled that profit was never in the
// data.
//
// Everything here is decided from the question text plus the real column
// names, so it behaves identically on every run.

interface Concept {
  id: string;
  /** Question wording that invokes the concept. */
  askedFor: RegExp;
  /** Column-name fragments that would mean the data really supports it. */
  satisfiedBy: RegExp;
  /** What to tell the user when it isn't supported. */
  message: string;
  /** Concepts that no aggregation can supply, even with related columns. */
  alwaysUnsupported?: boolean;
}

const CONCEPTS: Concept[] = [
  {
    id: "profit",
    askedFor: /\b(profit|margin|markup|net income|earnings|profitab)/i,
    satisfiedBy: /(profit|margin|cost|expense|cogs)/i,
    message: "these files have no cost or profit column, so profit/margin cannot be calculated — any revenue figure shown is revenue, not profit",
  },
  {
    id: "churn",
    askedFor: /\b(churn|attrit|retention|likely to (leave|cancel|quit)|at risk of leaving)/i,
    satisfiedBy: /(churn|attrit|retention|cancel|status|active)/i,
    message: "these files have no churn/retention column, so churn cannot be measured",
  },
  {
    id: "satisfaction",
    askedFor: /\b(satisf|happiness|morale|nps|sentiment|engagement score)/i,
    // Deliberately does NOT accept a generic "rating"/"score" column: asked
    // about manager satisfaction, a performance_rating column let the
    // warning through and the explanation then read performance ratings as
    // proof employees were "quite satisfied with their managers".
    satisfiedBy: /(satisf|nps|sentiment|morale|happiness)/i,
    message: "these files have no satisfaction/sentiment column, so satisfaction cannot be measured (a performance or quality rating is not a satisfaction measure)",
  },
  {
    id: "forecast",
    askedFor: /\b(predict|forecast|projection|will be|next (month|quarter|year)|future)/i,
    satisfiedBy: /$^/, // nothing in a static table can satisfy a forecast
    message: "this tool aggregates data that already exists and cannot forecast or predict future values",
    alwaysUnsupported: true,
  },
  {
    id: "causation",
    askedFor: /\b(cause[sd]?|because of|due to|drives?|impact of|effect of)\b/i,
    satisfiedBy: /$^/,
    message: "this tool can show correlation and comparison, but nothing in the data establishes causation",
    alwaysUnsupported: true,
  },
];

export interface ConceptWarning {
  id: string;
  message: string;
}

/** Concepts the question asks about that these columns cannot answer. */
export function detectUnsupportedConcepts(question: string, columns: ColumnSchema[]): ConceptWarning[] {
  const columnBlob = columns.map((c) => c.name).join(" ");
  const warnings: ConceptWarning[] = [];

  for (const concept of CONCEPTS) {
    if (!concept.askedFor.test(question)) continue;
    if (!concept.alwaysUnsupported && concept.satisfiedBy.test(columnBlob)) continue;
    warnings.push({ id: concept.id, message: concept.message });
  }
  return warnings;
}

/**
 * Renames aggregation aliases that claim a concept the source column can't
 * support — the "sum(total_amount) AS total_profit" case. The number stays;
 * the label stops lying about what it is.
 */
// Hedging in the planner's own reasoning, grouped by what it signals rather
// than by any particular wording: an inability to express the question, a
// deliberate substitution, an assumption being made, or an acknowledged
// ambiguity/limitation. Built from word stems so it catches the idea
// however a given model happens to phrase it.
const PLANNER_HEDGE = new RegExp(
  [
    // "cannot express / can't be represented / unable to compute ..."
    String.raw`\b(?:can'?t|cannot|can not|unable to|not possible to|no way to|isn'?t possible)\b[^.]{0,40}\b(?:express|represent|compute|capture|model|do|answer|support)\w*`,
    // "not directly expressible / not representable ..."
    String.raw`\bnot\b[^.]{0,20}\b(?:expressible|representable|supported|available|answerable)\b`,
    // substituting a different answer
    String.raw`\b(?:approximat\w+|closest\b[^.]{0,20}\banswer|as a proxy|proxy for|best effort|fall(?:ing)? back to|instead of what)\b`,
    // stating an assumption
    String.raw`\b(?:i'?ll assume|i am assuming|i'?m assuming|assuming that|we assume)\b`,
    // acknowledging ambiguity or a limitation
    String.raw`\b(?:given the ambiguity|ambiguous|ambiguity|this is a limitation|due to the limitation)\b`,
  ].join("|"),
  "i"
);

/**
 * Detects the planner conceding, in its own `reasoning`, that the plan
 * answers something other than what was asked. That admission is the single
 * most valuable honesty signal available — it comes from the component that
 * actually knows what it could and couldn't express — and silently dropping
 * it turns a known approximation into a confident wrong answer.
 */
export function detectPlannerHedging(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined;
  const match = reasoning.match(PLANNER_HEDGE);
  if (!match) return undefined;
  return `The query planner flagged that it could not express this question exactly and answered a narrower one instead (it said: "${match[0]}"). Treat the number below as an approximation of the question you asked, not a direct answer to it — check the Steps tab for the operations that actually ran.`;
}

export function stripMisleadingAliases(
  aggregations: { column: string; fn: string; as?: string }[] | undefined,
  warnings: ConceptWarning[]
): { aggregations: typeof aggregations; renames: string[] } {
  if (!aggregations?.length || warnings.length === 0) return { aggregations, renames: [] };

  const renames: string[] = [];
  const concepts = new Set(warnings.map((w) => w.id));
  const claims: Record<string, RegExp> = {
    profit: /(profit|margin|markup|earnings)/i,
    churn: /(churn|attrit|retention)/i,
    satisfaction: /(satisf|morale|nps|sentiment)/i,
    forecast: /(predict|forecast|project)/i,
  };

  const next = aggregations.map((agg) => {
    const alias = agg.as;
    if (!alias) return agg;
    for (const [conceptId, pattern] of Object.entries(claims)) {
      if (!concepts.has(conceptId) || !pattern.test(alias)) continue;
      // Don't rename if the SOURCE column genuinely is that concept.
      if (pattern.test(agg.column)) continue;
      const honest = `${agg.fn}_${agg.column}`;
      renames.push(`Renamed "${alias}" to "${honest}" — it is ${agg.fn} of ${agg.column}, not ${conceptId}.`);
      return { ...agg, as: honest };
    }
    return agg;
  });

  return { aggregations: next, renames };
}
