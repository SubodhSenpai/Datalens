import { ChartTool } from "./types";

export const barChartTool: ChartTool = {
  type: "function",
  chartType: "bar",
  function: {
    name: "render_bar_chart",
    description:
      "Render a bar chart comparing a numeric value across discrete categories. Best for ranking, comparison, and 'by <category>' / 'top N' / 'bottom N' questions with a small-to-moderate number of categories.",
    parameters: {
      type: "object",
      properties: {
        xKey: {
          type: "string",
          description: "Categorical column to use as the x-axis (one bar group per distinct value).",
        },
        yKeys: {
          type: "array",
          items: { type: "string" },
          description: "One or more numeric columns to plot as bars per category (multiple keys render grouped bars).",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["xKey", "yKeys"],
    },
  },
};
