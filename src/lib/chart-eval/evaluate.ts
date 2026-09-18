import { ChartEvalResult, ChartType } from "../types";
import { CHART_SELECTION_GUIDE, ChartRule } from "./reference";

export interface DataCharacteristics {
  /** Number of rows in the executed result (post-aggregation, if any). */
  categoryCount: number;
  hasDateColumn: boolean;
  numericColumnCount: number;
  /** Number of groupBy columns in the executed plan (e.g. 2 for a row+column breakdown). */
  groupByDimensionCount: number;
}

function ruleApplies(rule: ChartRule, question: string, data: DataCharacteristics): boolean {
  if (!rule.questionPatterns.some((pattern) => pattern.test(question))) return false;
  const c = rule.dataConditions;
  if (!c) return true;
  if (c.minCategories !== undefined && data.categoryCount < c.minCategories) return false;
  if (c.maxCategories !== undefined && data.categoryCount > c.maxCategories) return false;
  if (c.requiresDateColumn && !data.hasDateColumn) return false;
  if (c.minNumericColumns !== undefined && data.numericColumnCount < c.minNumericColumns) return false;
  if (c.minGroupByDimensions !== undefined && data.groupByDimensionCount < c.minGroupByDimensions) return false;
  return true;
}

// Judges the chart type the LLM's tool-calling actually picked against
// research-backed chart-selection guidance for this question/data shape.
// Returns matched: null (not actual/expected: false) when no guidance rule
// applies, so ambiguous questions don't get silently scored as wrong.
export function evaluateChartChoice(question: string, actualChartType: ChartType, data: DataCharacteristics): ChartEvalResult {
  const rule = CHART_SELECTION_GUIDE.find((r) => ruleApplies(r, question, data));
  if (!rule) {
    return { actualChartType, expectedChartType: null, matched: null };
  }
  return {
    actualChartType,
    expectedChartType: rule.expectedChartType,
    matched: actualChartType === rule.expectedChartType,
    ruleId: rule.id,
    rationale: rule.rationale,
    source: rule.source,
  };
}
