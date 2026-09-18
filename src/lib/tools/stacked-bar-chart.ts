import { ChartTool } from "./types";

export const stackedBarChartTool: ChartTool = {
  type: "function",
  chartType: "stacked-bar",
  function: {
    name: "render_stacked_bar_chart",
    description:
      "Render a stacked bar chart showing how multiple numeric series contribute to a total per category. Best for 'breakdown of X by Y' or 'composition of totals across categories' questions where both the total and its parts matter — unlike render_pie_chart, this scales to many categories and lets totals be compared across them.",
    parameters: {
      type: "object",
      properties: {
        xKey: {
          type: "string",
          description: "Categorical column to use as the x-axis (one stacked bar per distinct value).",
        },
        yKeys: {
          type: "array",
          items: { type: "string" },
          description: "Numeric columns to stack within each category's bar.",
        },
        title: { type: "string", description: "Short, human-readable chart title." },
      },
      required: ["xKey", "yKeys"],
    },
  },
};
