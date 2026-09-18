import { ChartTool } from "./types";

export const radarChartTool: ChartTool = {
  type: "function",
  chartType: "radar",
  function: {
    name: "render_radar_chart",
    description:
      "Render a radar (spider) chart comparing multiple numeric metrics across a small set of categories on shared axes. Best for 'compare X across these metrics' or profile/scorecard questions with 3-8 metrics and a handful of categories to compare (e.g. comparing a few products or regions across several KPIs at once).",
    parameters: {
      type: "object",
      properties: {
        metricKey: {
          type: "string",
          description: "Categorical column whose distinct values become the radar's axes (the metrics being compared).",
        },
        seriesKeys: {
          type: "array",
          items: { type: "string" },
          description: "One or more numeric columns, each rendered as its own overlaid shape on the radar (e.g. one per entity being compared).",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["metricKey", "seriesKeys"],
    },
  },
};
