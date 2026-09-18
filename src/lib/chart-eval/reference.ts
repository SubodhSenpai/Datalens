import { ChartType } from "../types";

export interface ChartRuleDataConditions {
  /** Result row count (post-aggregation) must be >= this. */
  minCategories?: number;
  /** Result row count (post-aggregation) must be <= this. */
  maxCategories?: number;
  /** At least one involved column must be a date column. */
  requiresDateColumn?: boolean;
  /** At least this many numeric columns must be involved. */
  minNumericColumns?: number;
  /** At least this many groupBy dimensions must be in the plan (e.g. 2 for a row+column breakdown). */
  minGroupByDimensions?: number;
}

export interface ChartRule {
  id: string;
  expectedChartType: ChartType;
  /** Any match against the question text triggers this rule. */
  questionPatterns: RegExp[];
  /** All given conditions must also hold against the executed result's shape. */
  dataConditions?: ChartRuleDataConditions;
  rationale: string;
  source: string;
}

// Ground-truth chart-selection guidance used to evaluate the LLM's chart
// tool-calling choices (see src/lib/chart-eval/evaluate.ts), sourced from
// established data-visualization guidance rather than invented in-house.
// Rules are checked in order; the first whose question pattern AND data
// conditions both match wins.
export const CHART_SELECTION_GUIDE: ChartRule[] = [
  {
    id: "trend-line",
    expectedChartType: "line",
    questionPatterns: [/trend/i, /over time/i, /\bmonthly\b/i, /\byearly\b/i, /by (day|week|month|quarter|year)/i, /timeline/i, /growth/i],
    dataConditions: { requiresDateColumn: true },
    rationale:
      "Line charts are the standard for continuous, time-based trend data — best suited when the number of data points is high and change over time is the point.",
    source: "https://querio.ai/articles/when-to-use-different-types-of-graphs",
  },
  {
    id: "cumulative-area",
    expectedChartType: "area",
    questionPatterns: [/cumulative/i, /running total/i, /accumulat/i],
    dataConditions: { requiresDateColumn: true },
    rationale:
      "Area charts communicate magnitude-under-the-curve for cumulative/running totals over time, where a bare line would only show direction, not size.",
    source: "https://www.thoughtspot.com/data-trends/data-visualization/types-of-charts-graphs",
  },
  {
    id: "distribution-histogram",
    expectedChartType: "histogram",
    questionPatterns: [/distribut/i, /spread of/i, /how is .* distributed/i, /histogram/i],
    rationale:
      "A histogram looks like a bar chart but serves a fundamentally different purpose: it shows how values of a single numeric column are distributed across binned ranges, not a category comparison.",
    source: "https://querio.ai/articles/when-to-use-different-types-of-graphs",
  },
  {
    id: "correlation-scatter",
    expectedChartType: "scatter",
    questionPatterns: [/correlat/i, /relationship between/i, /\bvs\.?\b/i, /\bversus\b/i],
    dataConditions: { minNumericColumns: 2 },
    rationale: "Scatter plots reveal the relationship between two numeric variables, point by point, for identifying patterns and correlations.",
    source: "https://querio.ai/articles/when-to-use-different-types-of-graphs",
  },
  {
    id: "multi-metric-radar",
    expectedChartType: "radar",
    questionPatterns: [/compare .* across (these |the )?(metrics|criteria|dimensions)/i, /\bprofile\b/i, /\bscorecard\b/i],
    dataConditions: { maxCategories: 9 },
    rationale: "Radar charts compare multiple metrics for a small set of entities on shared axes; guidance caps this around 10 factors before it gets unreadable.",
    source: "https://www.luzmo.com/blog/chart-types",
  },
  {
    id: "proportion-small-pie",
    expectedChartType: "pie",
    questionPatterns: [/proportion/i, /share of/i, /breakdown/i, /percentage of/i, /what fraction/i],
    dataConditions: { maxCategories: 5 },
    rationale: "Pie charts are only reliable for showing parts of a whole with 5 or fewer categories — beyond that, comparing angles/slices degrades quickly.",
    source: "https://inforiver.com/insights/11-pie-chart-alternatives-and-when-to-use-them/",
  },
  {
    id: "proportion-large-treemap",
    expectedChartType: "treemap",
    questionPatterns: [/proportion/i, /share of/i, /breakdown/i, /percentage of/i],
    dataConditions: { minCategories: 6 },
    rationale:
      "Once a part-to-whole breakdown exceeds ~5 categories, treemaps (compared by rectangle area) read more reliably than pie slices (compared by angle).",
    source: "https://yurbi.com/blog/treemaps-vs-pie-charts/",
  },
  {
    id: "composition-stacked-bar",
    expectedChartType: "stacked-bar",
    questionPatterns: [/composition of/i, /breakdown of .* by/i],
    dataConditions: { minCategories: 2 },
    rationale: "Stacked bars show both a category's total and its component parts at once, and scale to more categories than a pie chart can.",
    source: "https://www.thoughtspot.com/data-trends/data-visualization/types-of-charts-graphs",
  },
  {
    id: "two-dimension-heatmap",
    expectedChartType: "heatmap",
    questionPatterns: [/heatmap/i, /\bmatrix\b/i, /\bgrid of\b/i, /by .+ and .+ (combined|together)/i],
    dataConditions: { minGroupByDimensions: 2, minCategories: 9 },
    rationale:
      "A value broken down by two categorical dimensions at once, with a reasonably dense grid, is exactly what a heatmap is for — reading the same thing off a table gets hard fast once there are two group-by axes.",
    source: "https://www.atlassian.com/data/charts/heatmap-complete-guide",
  },
  {
    id: "many-categories-dot",
    expectedChartType: "dot",
    questionPatterns: [
      /top \d+/i,
      /bottom \d+/i,
      /\bhighest\b/i,
      /\blowest\b/i,
      /\bmost\b/i,
      /\bleast\b/i,
      /\bcompare\b/i,
      /\bby (category|region|product|customer|type|segment|department|group)\b/i,
      /\brank/i,
    ],
    dataConditions: { minCategories: 13 },
    rationale:
      "Once there are more than about a dozen categories, bars start crowding each other — a Cleveland dot plot (position instead of bar length) stays readable and precise at that scale.",
    source: "https://www.domo.com/learn/charts/cleveland-dot-plot",
  },
  {
    id: "ranking-comparison-bar",
    expectedChartType: "bar",
    questionPatterns: [
      /top \d+/i,
      /bottom \d+/i,
      /\bhighest\b/i,
      /\blowest\b/i,
      /\bmost\b/i,
      /\bleast\b/i,
      /\bcompare\b/i,
      /\bby (category|region|product|customer|type|segment|department|group)\b/i,
      /\brank/i,
    ],
    rationale: "Bar charts are the default, most legible way to compare discrete categories — the most common chart for exactly this reason.",
    source: "https://querio.ai/articles/when-to-use-different-types-of-graphs",
  },
  {
    id: "scalar-none",
    expectedChartType: "none",
    questionPatterns: [/^what is the (total|average|sum|count|max(imum)?|min(imum)?)\b/i, /^how many\b/i],
    dataConditions: { maxCategories: 1 },
    rationale: "A single-number answer doesn't need a chart — there's nothing to plot.",
    source: "https://www.thoughtspot.com/data-trends/data-visualization/types-of-charts-graphs",
  },
];
